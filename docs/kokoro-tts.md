# Native Kokoro TTS with sherpa-onnx

Papercut's go-forward TTS path is native sherpa-onnx running the Kokoro model. The previous browser Web Worker / kokoro-js fallback has been removed from active playback and audiobook saving because it was too slow on Android and was limited by browser/WebView inference constraints.

The design goal is still offline-first: model files live on the user's device, audiobook chunks are generated only when a user asks to save a document, and generated audio is stored as user data instead of being pre-rendered into the app bundle.

## Runtime Architecture

The frontend owns document parsing, HTML narration chunking, the platform-neutral playback state consumed by controls and highlighting, saved-audiobook state, downloads, and diagnostics. Native code owns synthesis, the fast audiobook-save path, persisted playback indexes, and mobile background playback.

The boundary is intentionally small:

- `src/tts/api/nativeTts.ts` calls Tauri commands and subscribes to native model-install/save progress events.
- `src-tauri/src/native_tts/` is the Rust backend module. Its `commands` layer exposes the Tauri commands and dispatches, via one `#[cfg]` switch, to either the `engine` submodules (real sherpa-onnx synthesis, compiled with `native-tts-core`) or a `stub` fallback when native TTS is not compiled. Inside `engine`: `model` downloads/verifies the pinned model, `synth` loads sherpa-onnx and synthesizes individual chunks, `save` runs native batch generation and writes a durable timing index, `cache` scans saved chunks and parses WAV headers, `playback` prepares or reuses one cached mobile playback track, and `bundle` (`export`/`import`/`manage`) handles audiobook export/import and deletion. `paths`/`config` hold shared path/id/constant helpers, and OS-specific tuning (thread counts) lives in `platform`.
- `src/tts/hooks/useTtsPlayer.ts` exposes one playback state contract to the UI. Desktop reads a bounded window of saved chunk WAVs; mobile maps one native track timeline back to chunk-local state. It never synthesizes missing chunks live.
- `src/tts/playback/nativeMobileAudio.ts` is the narrow adapter around the official, exactly pinned `tauri-plugin-native-audio` 1.0.5 API. Papercut serializes bridge commands and owns its foreground polling cadence instead of forking or modifying the plugin.
- `src/tts/hooks/useAudiobookCache.ts` checks native audiobook files and starts long-running native save jobs.
- `src/tts/hooks/useAudiobookManager.ts` coordinates React audiobook state, playback actions, saved-download/import/export/delete flows, and the prop bundles consumed by the audio UI components.
- `src/components/DocumentViewer/DocumentViewer.tsx` hosts the reader shell and exposes slots for TTS controls/diagnostics while owning Find, scroll-to-top, iframe sizing, and current-chunk highlighting.
- `src/tts/components/AudioControls.tsx`, `src/tts/components/AudiobooksPanel.tsx`, `src/tts/hooks/useTtsHighlight.ts`, and `src/tts/utils/format.ts` keep document playback controls, saved-download UI, highlight behavior, and audiobook display formatting out of `App.tsx`.

This keeps expensive inference and large WAV writes out of the WebView while preserving the existing React UI, highlighting contract, portable bundle format, and offline cache metadata.

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

The explicit prepare commands are useful for setup and troubleshooting, but `npm run android:apk:native-tts` also ensures the sherpa Android libraries are present before building. The native Android wrapper sets `JAVA_HOME` and `SHERPA_ONNX_LIB_DIR` automatically for the default arm64 APK path. `npm run prepare:jdk` installs a repo-local Eclipse Temurin JDK 17 into `src-tauri/tts/runtime/jdk/temurin-17` when a system JDK is not available. The fallback JDK archive is pinned to Eclipse Temurin 17.0.19+10, and both the JDK archive and sherpa Android archive are verified with SHA-256 before extraction. Downloads are written through temporary files before being promoted to their cache path. The Android build still requires the normal Android SDK/NDK prerequisites. Native background audio raises the app minimum to Android API 26, matching the plugin's Media3 service requirement.

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
7. Save writes a versioned `manifest.json` containing compact chunk timing/size metadata. On first mobile Play, Rust reuses a restored bundle track when available or streams the saved chunks into an atomic cached `playback.wav`; later plays reuse that track and its `playback.json` boundaries.

Save uses a conservative chunk profile that is separate from playback chunking. Playback keeps larger chunks for comfortable skip/highlight behavior, while Save uses smaller sentence-like chunks so one problematic text range is less likely to kill a long Android job and Resume has less work to retry.

### Narration Text Alignment

Narration chunks are built from reusable readable-text segments instead of raw `body.textContent`. The HTML adapter turns headings, paragraphs, list items, and other readable blocks into ordered segments, and treats wrapper containers as structure when they contain nested readable blocks; future EPUB/PDF adapters should produce the same segment shape instead of adding format-specific rules to the TTS hooks. Chunking keeps headings separate from paragraph merges so playback highlights do not disappear or span awkwardly across visual section changes.

The viewer highlighter requires the CSS Custom Highlight API provided by the supported desktop and Android WebViews. Chunking retains runtime-only source spans that identify each chunk's readable segment indexes and normalized offsets without changing chunk text or ids. After iframe load, the viewer builds a one-pass index of readable leaf blocks during browser idle (with an immediate fallback if playback starts first); it does not concatenate the full document or allocate per-character node/offset arrays. Only the active chunk's boundary segments are scanned to create a DOM `Range`, and an LRU cache retains up to 128 visited ranges. One registered `Highlight` object owns the active range, and shutdown clears it before removing the registry entry. Smooth scrolling waits briefly for rapid navigation to settle so repeated skip taps do not start competing scroll animations.

Playback navigation is latest-intent-wins on both backends. Backward, Forward, automatic advance, and chapter-list jumps update one target. Desktop keeps separate pending and committed indexes around its foreground chunk loader. Mobile keeps one serialized native seek worker, one queued target, and one active pending target that is cleared when the seek commits or exits. Repeated taps replace the queued target, so obsolete intermediate seeks do not commit audio or highlighting. Desktop and mobile pending indexes remain separate so a completed mobile jump cannot become the base for a later Forward or Backward action.

Desktop audio loading remains bounded: one foreground chunk load may run alongside one sequential speculative lookahead worker, and only a small Blob URL window is retained. Mobile performs no per-tap file read, base64 decode, Blob creation, or source replacement: Media3/AVPlayer streams one local track and each chunk jump is a global seek. The timing array is `O(n)` small metadata, and active-chunk lookup uses binary search (`O(log n)`). Native command responses update React immediately; ordinary visible progress uses one non-overlapping 250 ms poll, avoiding the plugin's high-frequency event stream. The document iframe is memoized, the chapter menu virtualizes its rows, and highlight alignment is current-chunk-only. This keeps steady-state work bounded for hundreds or thousands of chunks.

This changed chunk boundaries, so the native audiobook cache version is now `native-save-v4-segmented`. Older saved-audiobook records and exported bundles from previous cache versions are treated as incompatible and should be re-saved/re-exported.

Native synthesis sanitizes text before calling sherpa-onnx: smart punctuation is normalized, zero-width/control characters are removed, whitespace is collapsed, and emoji/non-BMP symbols are dropped for the English Kokoro path. This slightly changes unusual source text, but it avoids feeding unsupported characters into native tokenization.

Read playback is saved-only: the viewer Play button appears only when the current document has a complete saved audiobook for the selected voice and speed. Playback reads native saved-audiobook files and does not synthesize missing chunks live. Desktop uses the bounded React chunk window. Mobile hands one cached local track to the official native plugin and delegates playback, notification controls, lock-screen controls, audio focus, and wake behavior to the platform player. Native global time is converted back to the same `currentChunkIndex`, chunk-local time, and progress fields used by highlighting and the existing controls.

While the WebView is hidden or the screen is locked, the native player and media session remain the playback source of truth and continue without React. Papercut stops foreground polling while hidden. On return it reads the current native state once, updates chunk refs and highlighting, and restarts one generation-fenced, non-overlapping poll. Mobile controls wait for that foreground synchronization before acting.

These playback and highlighting rules do not change narration text, chunk ids, cache keys, chunk WAV filenames, or the exported audiobook format, so they do not require an audiobook cache-version bump. Highlight source spans are rebuilt from source HTML whenever a document opens and are removed at the Tauri IPC boundary; existing saved audio and imported bundles do not need regeneration. Internal native manifests use one exact current schema; older local manifest schemas are intentionally treated as incompatible and can be replaced by saving the audiobook again. This does not change bundle compatibility because every import writes a fresh current manifest from the bundle's canonical source and chunk WAVs. A desktop-generated `.papercut-audiobook` remains portable because mobile import restores its source HTML, chunk WAVs, and bundled single track when present. Bundles contain no device path or plugin-specific state; if a track is absent, mobile derives it from the restored chunks.

### Native Mobile Playback Constraints

- First mobile play is `O(n)` in saved audio bytes when no valid cached or imported track exists: Rust streams chunk payloads into an atomic `playback.wav`. Later plays reuse it. Imported `.papercut-audiobook` bundles normally restore their included single track and only need lightweight metadata validation.
- Runtime playback does not load the whole audiobook into JavaScript memory. The native player streams the local track while React retains chunk text, timing boundaries, and normal UI state.
- The cached track approximately duplicates chunk audio on disk and uses the standard RIFF/WAV 4 GB size field. The stitcher streams data rather than loading the full book into memory; compressed native playback can be evaluated separately if books approach that format limit.
- Official plugin 1.0.5 does not expose a non-destructive Stop or clear-source command. Papercut implements runtime Stop as pause plus seek-to-zero. On Android, the paused system media card may remain available until Media3 retires the inactive service or the app tears down the session.
- Papercut pins the official Rust crate and JavaScript package to 1.0.5. App-owned Rust prepares the track and chunk boundaries; app-owned TypeScript handles command serialization, latest-target seek coalescing, global-time mapping, and the 250 ms visible polling cadence. No plugin source is vendored or patched.
- The frontend path recognizes iOS and the plugin uses AVPlayer/Now Playing controls. The same single-track contract applies on Android and iOS; when the Tauri Apple project is added, the app target must enable Background Modes -> Audio. Papercut's currently supported native TTS/import build remains desktop and Android, so iOS packaging and native audiobook availability still require separate enablement and device CI.

## Audio UI

The document header exposes one consolidated audio control surface:

- Play starts reading the current document.
- Pause and Resume control the active desktop audio element or native mobile media session.
- Stop cancels playback, clears temporary desktop object URLs, and pauses/resets the reusable native mobile session. Full native disposal is reserved for app teardown.
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
- `[tts-playback] native preparation completed`
- `[tts-playback] native source loaded`
- `[tts-highlight] DOM segment index built`
- `[tts-highlight] slow chunk range built`
- `[tts-highlight] chunk range unavailable`

Useful fields are `backend`, `modelDir`, `totalChunks`, `cachedChunks`, `generatedChunks`, `chunkNumber`, `chunkId`, `textPreview`, `generateMs`, `audioDurationSec`, `realTimeFactor`, `wavBytes`, `threadCount`, `dir`, `segments`, `elapsedMs`, and `reason`.

Interpretation guide:

- High first-chunk time usually means native model load plus first inference warmup.
- High `realTimeFactor` after warmup means synthesis is the bottleneck.
- If a higher `threadCount` improves `realTimeFactor`, keep it for that device; if it crashes, heats up, or throttles during long saves, return to 1 thread on Android.
- If Resume crashes at the same point, inspect the last `[tts-save] native chunk start` entry. The `chunkNumber`, `chunkId`, and `textPreview` identify the text range being passed to native synthesis when the process died.
- Repeated cache misses usually mean the document, chunk text, voice, speed, model id, or audiobook cache version changed.
- A high `[tts-highlight] DOM segment index built` time means iframe DOM traversal is still expensive; normal work scales with DOM nodes, not audiobook characters.
- `[tts-highlight] slow chunk range built` usually identifies one unusually large readable block. `[tts-highlight] chunk range unavailable` means runtime source spans and iframe structure disagree and includes a reason field.

## Version-Control Practice

Large runtime assets stay out of git. Commit code, scripts, docs, Cargo files, package metadata, and `src-tauri/tts/model-manifest.json`; do not commit downloaded model files, generated Android libraries, built frontend output, or generated audiobook WAV chunks.

The current native audiobook cache version is `native-save-v4-segmented`. Updating that value intentionally invalidates older saved-audiobook records and incomplete downloads because their chunk boundaries or text normalization may no longer match. The app hides old records but does not automatically delete their files from user data.

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
- Return saved WAV chunks as raw Tauri IPC bytes from an async command instead of base64-encoding them in Rust and decoding/copying them in JavaScript.
- Add resumable/range-aware model downloads if interrupted downloads become common on mobile networks.
- Evaluate compressed export audio if users need a portable single track beyond the standard 4 GB RIFF/WAV limit.
- Extend saved-audiobook support to PDFs with page-aware manifests and text-layer positions.
- Explore native GPU/NNAPI/CoreML/DirectML provider support only after the CPU native path is measured on target devices.

## Sources

- sherpa-onnx Android build docs: https://k2-fsa.github.io/sherpa/onnx/android/build-sherpa-onnx.html
- sherpa-onnx Rust crate docs: https://docs.rs/sherpa-onnx
- Tauri command IPC: https://v2.tauri.app/develop/calling-rust/
- native audio plugin: https://github.com/uvarov-frontend/tauri-plugin-native-audio
