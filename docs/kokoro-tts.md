# Native Kokoro TTS with sherpa-onnx

Papercut's go-forward TTS path is native sherpa-onnx running the Kokoro model. The previous browser Web Worker / kokoro-js fallback has been removed from active playback and audiobook saving because it was too slow on Android and was limited by browser/WebView inference constraints.

The design goal is still offline-first: model files live on the user's device, audiobook chunks are generated only when a user asks to save a document, and generated audio is stored as user data instead of being pre-rendered into the app bundle.

## Runtime Architecture

The frontend owns document parsing, HTML narration chunking, playback state, saved-audiobook state, downloads, and diagnostics. Native code owns synthesis and the fast audiobook-save path.

The boundary is intentionally small:

- `src/tts/api/nativeTts.ts` calls Tauri commands and subscribes to native model-install/save progress events.
- `src-tauri/src/native_tts/` is the Rust backend module. Its `commands` layer exposes the Tauri commands and dispatches, via one `#[cfg]` switch, to either the `engine` submodules (real sherpa-onnx synthesis, compiled with `native-tts-core`) or a `stub` fallback when native TTS is not compiled. Inside `engine`: `model` downloads/verifies the pinned model, `synth` loads sherpa-onnx and synthesizes individual chunks, `save` runs native batch generation and saves full audiobooks directly to app data, `cache` scans saved chunks and parses WAV metadata, and `bundle` (`export`/`import`/`manage`) handles audiobook export/import and deletion. `paths`/`config` hold shared path/id/constant helpers, and OS-specific tuning (thread counts) lives in `platform`.
- `src/tts/hooks/useTtsPlayer.ts` reads native saved-audiobook files for playback and does not synthesize missing chunks live.
- `src/tts/hooks/useAudiobookCache.ts` checks native audiobook files and starts long-running native save jobs.
- `src/tts/hooks/useAudiobookManager.ts` coordinates React audiobook state, playback actions, saved-download/import/export/delete flows, and the prop bundles consumed by the audio UI components.
- `src/components/DocumentViewer/DocumentViewer.tsx` hosts the reader shell and exposes slots for TTS controls/diagnostics while owning Find, scroll-to-top, iframe sizing, and current-chunk highlighting.
- `src/tts/components/AudioControls.tsx`, `src/tts/components/AudiobooksPanel.tsx`, `src/tts/hooks/useTtsHighlight.ts`, and `src/tts/utils/format.ts` keep document playback controls, saved-download UI, highlight behavior, and audiobook display formatting out of `App.tsx`.

This keeps expensive inference and large WAV writes out of the WebView while preserving the existing React UI and offline cache metadata.

## Model Download

The app does not package the Kokoro model into desktop installers or Android APKs by default. Users install the voice model once from the Audiobook settings cog with **Download voice model**. The button describes what is being downloaded and names the official source.

Pinned model asset:

- Source: k2-fsa/sherpa-onnx Kokoro multi-lang v1.0
- URL: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
- SHA-256: `c133d26353d776da730870dac7da07dbfc9a5e3bc80cc5e8e83ab6e823be7046`
- Archive size: 349,418,188 bytes, about 333 MB
- Manifest: `src-tauri/tts/model-manifest.json`

Desktop and Android use this same model archive. The archive contains model/data files, not platform-specific native code. Platform-specific pieces are handled separately: desktop builds use the Rust `sherpa-onnx` dependency, and Android native TTS uses the official sherpa-onnx Android shared-library archive prepared by `npm run prepare:sherpa-android-libs`.

At install time, Rust downloads the archive into a temporary app cache directory, verifies the SHA-256, extracts it, checks required files, and then moves it into Tauri app data under `models/sherpa-onnx/kokoro-multi-lang-v1_0/`. If verification or extraction fails, the incomplete temp directory is not used as a model.

Existing saved audiobook files are not changed by this model-download change. The saved-audiobook cache key/version is separate from where the model is installed. Existing saved WAV chunks remain app user data and playback still reads them from the native audiobook cache.

## Build And Run

Browser preview still works for document/search UI:

```bash
npm run browser
```

TTS synthesis is native-only, so browser preview will report native TTS as unavailable.

Desktop builds compile the native TTS feature:

```bash
npm run desktop
```

Android debug APK builds without native TTS still use the normal command:

```bash
npm run android:apk
```

Android native TTS uses the official sherpa-onnx Android shared-library archive, copies the shared objects into Tauri's generated `jniLibs`, and builds only the common arm64 target by default:

```bash
npm run prepare:jdk
npm run prepare:sherpa-android-libs
npm run android:apk:native-tts
```

The explicit prepare commands are useful for setup and troubleshooting, but `npm run android:apk:native-tts` also ensures the sherpa Android libraries are present before building. The native Android wrapper sets `JAVA_HOME` and `SHERPA_ONNX_LIB_DIR` automatically for the default arm64 APK path. `npm run prepare:jdk` installs a repo-local Eclipse Temurin JDK 17 into `src-tauri/tts/runtime/jdk/temurin-17` when a system JDK is not available. The fallback JDK archive is pinned to Eclipse Temurin 17.0.19+10, and both the JDK archive and sherpa Android archive are verified with SHA-256 before extraction. Downloads are written through temporary files before being promoted to their cache path. The Android build still requires the normal Android SDK/NDK prerequisites.

The Node build scripts are orchestration around npm, Cargo, Tauri, Gradle, and SDK Manager rather than a replacement for those tools. Shared helpers in `scripts/lib/` own project paths, version constants, child-process execution, archive extraction, and checked downloads. Platform-specific helpers live in `scripts/lib/android/` for Android JDK/sherpa setup and `scripts/lib/linux/` for Linux shared-library bundling. Script entrypoints such as `prepare:sherpa-android-libs`, `android:apk:native-tts`, and `desktop` call those helpers instead of relying on import side effects or duplicated archive/spawn code. Android APK variants are handled by one top-level `scripts/build-android.js`; the native TTS npm command passes `--native-tts` to that script.

`npm run android:apk:native-tts` does not copy model files into Android assets. The first TTS use on Android follows the same in-app model download path as desktop, so the APK stays smaller and developers do not need to carry large model assets between machines.

## Cache Strategy

Papercut does not generate corpus-wide audiobook files at build time. That approach does not scale because every new document would increase build time and bundle size.

Instead, audio is generated on demand:

1. The user opens an HTML document and clicks Save.
2. The app builds deterministic narration chunks for that document.
3. The native audiobook directory in app data is scanned for existing WAV chunks.
4. A single native save job generates every missing chunk in sequence and writes WAV files directly to app data.
5. Native progress events update the React Audiobooks panel and TTS diagnostics.
6. A localStorage registry marks the audiobook complete only when every chunk exists.

Save uses a conservative chunk profile that is separate from playback chunking. Playback keeps larger chunks for comfortable skip/highlight behavior, while Save uses smaller sentence-like chunks so one problematic text range is less likely to kill a long Android job and Resume has less work to retry.

Native synthesis sanitizes text before calling sherpa-onnx: smart punctuation is normalized, zero-width/control characters are removed, whitespace is collapsed, and emoji/non-BMP symbols are dropped for the English Kokoro path. This slightly changes unusual source text, but it avoids feeding unsupported characters into native tokenization.

Read playback is saved-only: the viewer Play button appears only when the current document has a complete saved audiobook for the selected voice and speed. Playback reads native saved-audiobook files and does not synthesize missing chunks live. Playback is windowed: React loads the current chunk and a small lookahead instead of scanning every saved WAV up front. This keeps very long audiobooks responsive and avoids creating hundreds of Blob URLs at once.

## Audio UI

The document header exposes one consolidated audio control surface:

- Play starts reading the current document.
- Pause and Resume control the active audio element.
- Stop cancels playback and clears temporary object URLs.
- Backward and Forward jump by narration chunk.
- The burger/list button opens a mobile-friendly chunk list for long audiobooks. Rows show an estimated start timestamp when total saved duration is known and jump directly to that chunk.
- Save generates and persists the full audiobook for the current HTML document.
- Saved appears when the full audiobook exists locally for the selected voice and speed.
- Download voice model installs the pinned Kokoro model once into app data.
- Threads controls the native ONNX Runtime thread count for benchmarking save/playback throughput on the current device.

The home screen Audiobooks panel shows active or resumable saves with progress bars, completed saved audiobooks, export/delete actions, saved duration, saved percent, stored size, and the voice/speed metadata for each item. Completed saved audiobooks are shown regardless of the currently selected voice; opening one switches the UI to that record's voice and speed before viewing the document. The document list/search results can still be filtered to documents with saved audio for the current voice/speed selection.

## Diagnostics

The in-app TTS diagnostics panel is the primary way to monitor desktop and mobile builds without devtools. The native path emits:

- `tts-model-install-progress`
- `[tts-native] capabilities`
- `[tts-save] native chunk start`
- `[tts-save] native chunk`
- `[tts-save] completed`
- `[tts-save] failed`

Useful fields are `backend`, `modelDir`, `totalChunks`, `cachedChunks`, `generatedChunks`, `chunkNumber`, `chunkId`, `textPreview`, `generateMs`, `audioDurationSec`, `realTimeFactor`, `wavBytes`, `threadCount`, and `dir`.

Interpretation guide:

- High first-chunk time usually means native model load plus first inference warmup.
- High `realTimeFactor` after warmup means synthesis is the bottleneck.
- If a higher `threadCount` improves `realTimeFactor`, keep it for that device; if it crashes, heats up, or throttles during long saves, return to 1 thread on Android.
- If Resume crashes at the same point, inspect the last `[tts-save] native chunk start` entry. The `chunkNumber`, `chunkId`, and `textPreview` identify the text range being passed to native synthesis when the process died.
- Repeated cache misses usually mean the document, chunk text, voice, speed, model id, or audiobook cache version changed.

## Version-Control Practice

Large runtime assets stay out of git. Commit code, scripts, docs, Cargo files, package metadata, and `src-tauri/tts/model-manifest.json`; do not commit downloaded model files, generated Android libraries, built frontend output, or generated audiobook WAV chunks.

The current native audiobook cache version is `native-save-v3-360-sanitized`. Updating that value intentionally invalidates older saved-audiobook records and incomplete downloads because their chunk boundaries or text normalization may no longer match. The app hides old records but does not automatically delete their files from user data.

Generated files that should stay uncommitted:

```
src-tauri/tts/runtime/
dist/
```

Do not commit generated audiobook WAV chunks. Full Save writes runtime user data under the app data audiobook cache.

## Why The Browser Worker Was Removed

The browser Kokoro worker was useful for proving the feature, but it hit the wrong performance ceiling:

- Android WebView worker execution was slow for full audiobook generation.
- WebGPU availability and performance varied across Chromium, Linux desktop WebViews, and Android WebView.
- Cross-origin isolation improved WASM threading but did not solve the main inference cost.
- Keeping q8/q4/WebGPU/WASM switches made the UI and cache model more complex without producing LocalReader-Pro-class throughput.

Native sherpa-onnx is a better base because inference runs outside the WebView sandbox and can use native ONNX Runtime threading/provider support.

## Further Improvements

The next valuable work is native execution depth, not more browser fallback tuning:

- Add a native Android foreground service for long-running audiobook saves so generation can continue while the app is backgrounded.
- Add deeper cancellation support inside sherpa generation itself so Cancel can interrupt a long current chunk, not only stop before the next chunk.
- Add resumable/range-aware model downloads if interrupted downloads become common on mobile networks.
- Store one combined audiobook file per saved document after chunk generation if export/share or simpler playback becomes important.
- Extend saved-audiobook support to PDFs with page-aware manifests and text-layer positions.
- Explore native GPU/NNAPI/CoreML/DirectML provider support only after the CPU native path is measured on target devices.

## Sources

- sherpa-onnx Android build docs: https://k2-fsa.github.io/sherpa/onnx/android/build-sherpa-onnx.html
- sherpa-onnx Rust crate docs: https://docs.rs/sherpa-onnx
