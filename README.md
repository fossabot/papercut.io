# Papercut [![Latest release](https://img.shields.io/github/v/release/muhannadnouri/papercut.io?logo=github&color=6366f1)](https://github.com/muhannadnouri/papercut.io/releases/latest) [![CI](https://github.com/muhannadnouri/papercut.io/actions/workflows/ci.yml/badge.svg)](https://github.com/muhannadnouri/papercut.io/actions/workflows/ci.yml) [![React](https://img.shields.io/badge/React-19-20232A?logo=react&logoColor=61DAFB)](https://react.dev/) [![Tauri + Rust](https://img.shields.io/badge/Tauri_+_Rust-2.x_|_1.77+-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

**Homepage:** 👉 [trypapercut.netlify.app](https://trypapercut.netlify.app) 👈

[![Download for Android](https://img.shields.io/badge/Download-Android-3DDC84?logo=android&logoColor=white)](https://trypapercut.netlify.app/#downloads-title) [![Download for Linux](https://img.shields.io/badge/Download-Linux-FCC624?logo=linux&logoColor=black)](https://trypapercut.netlify.app/#downloads-title) [![Download for Windows](https://img.shields.io/badge/Download-Windows-0078D4?logo=windows11&logoColor=white)](https://trypapercut.netlify.app/#downloads-title)


Papercut is an offline reader for searching, reading, and listening to document collections. Built with Tauri, React, Vite, Pagefind, SQLite FTS, and native Kokoro TTS.

Bundled documents are indexed at build time using Pagefind, which creates a compressed search index. User-imported HTML documents are indexed at runtime into a local SQLite FTS database in Tauri app data, so users can add their own documents without rebuilding the app. At runtime, only the relevant search provider is queried and results are merged into one UI. The entire application runs offline with no server or internet connection required.

## Prerequisites

| Tool  | Minimum Version | Recommended Version |
|-------|-----------------|---------------------|
| Node  | >= 22.12.0      | 22.22.1             |
| npm   | >= 10.9.0       | 10.9.4              |
| Rust  | >= 1.77.2       | 1.94.0              |
| Cargo | >= 1.77.2       | 1.94.0              |

<details>
<summary><strong>Platform setup details</strong></summary>

### Install Node.js

**Linux / macOS** — using [nvm](https://github.com/nvm-sh/nvm) (recommended):

```bash
nvm install 22
nvm use 22
```

**Windows** — using [nvm-windows](https://github.com/coreybutler/nvm-windows) (recommended):

```powershell
nvm install 22.22.1
nvm use 22.22.1
```

Or install directly from the [Node.js download page](https://nodejs.org/en/download).

### Install Rust

**Ubuntu/Debian/Mint:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Arch-based (CachyOS, Manjaro, etc.):**

```bash
sudo pacman -S rustup
rustup default stable
```

> If using fish shell, the Cargo bin directory is already on your PATH via the system rustup package. Verify with `rustc --version`.

**Windows:** download and run [rustup-init.exe](https://www.rust-lang.org/tools/install). Choose the default `stable-x86_64-pc-windows-msvc` toolchain. Open a new terminal after install so `cargo` and `rustc` are on `PATH`.

### System Dependencies (Linux)

Tauri requires the following system libraries. Refer to the Tauri [documentation](https://v2.tauri.app/start/prerequisites/#linux) for full details.

**Debian-based (Ubuntu,Mint etc.):**

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file libssl-dev libxdo-dev
```

**Arch-based (CachyOS, Manjaro, etc.):**

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

### Android Prerequisites

Required to build the Android APK:

| Tool        | Minimum Version |
|-------------|-----------------|
| Java (JDK)  | 17              |
| Android SDK | API 26+         |
| Android NDK | 29.0.13846066   |

**Install Java 17:**

The Android build scripts can prepare a repo-local Eclipse Temurin JDK 17 automatically. This is useful in sandboxed editor environments where system package managers are not available:

```bash
npm run prepare:jdk
```

The local JDK is extracted to `src-tauri/tts/runtime/jdk/temurin-17`, which is ignored by git. The fallback archive is pinned to Eclipse Temurin 17.0.19+10 and verified with SHA-256 before extraction. The helper downloads through a temporary file and only promotes the archive after a completed fetch, so interrupted downloads do not leave a partial archive in place. `npm run android:apk` and `npm run android:apk:native-tts` set `JAVA_HOME` to this local JDK automatically when no external `JAVA_HOME` is available.

System JDK installs also work:

```bash
# Ubuntu/Debian
sudo apt install openjdk-17-jdk

# Arch-based
sudo pacman -S jdk17-openjdk
```

**Install Android SDK and NDK:**

Install [Android Studio](https://developer.android.com/studio) (recommended) or the command-line tools only. Then install the NDK via SDK Manager:

```bash
sdkmanager "ndk;29.0.13846066"
```

**Install Rust Android targets** (one-time):

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

**Set required environment variables:**

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/29.0.13846066
```

### System Dependencies (Windows)

Tauri on Windows needs two things beyond Node and Rust:

1. **Microsoft Visual Studio C++ Build Tools** — required for the MSVC linker used by Rust. Install from the [Visual Studio Build Tools page](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and select the "Desktop development with C++" workload.
2. **Microsoft Edge WebView2 Runtime** — the renderer Tauri uses. Preinstalled on Windows 11 and up-to-date Windows 10. If missing, install the [Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

Refer to the Tauri [Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) for full details.

</details>

## Getting Started

### Install dependencies

```bash
npm install
```

### Development

```bash
npm run tauri:dev
```

This starts the Vite dev server and launches the Tauri desktop window with hot reload. Bundled-document search requires a built Pagefind index, so bundled search is only available after `npm run build`. Runtime uploaded-document search works inside the Tauri app after documents are imported.

<details>
<summary><strong>Production, release, Android, TTS, and browser builds</strong></summary>

### Production build

```bash
npm run desktop
```

When this command is run from a Flatpak-hosted editor terminal, the script automatically delegates the desktop build to the host OS with `flatpak-spawn --host`. That keeps the command the same while letting Tauri and `linuxdeploy` see the real host WebKitGTK/GTK libraries needed for `.deb`, `.rpm`, and AppImage bundling. You do not need to source `tauri-env.sh` before `npm run desktop`; if it has already been sourced, the desktop wrapper removes the Flatpak pkg-config variables before running the host build.

This runs the full pipeline:

1. TypeScript compilation
2. Vite frontend build
3. Pagefind indexes all HTML documents in `public/documents/`
4. Tauri compiles the Rust backend and bundles the desktop application

The built binary is output to `src-tauri/target/release/app` (`app.exe` on Windows). Installers are generated in `src-tauri/target/release/bundle/`:

- **Linux:** `.deb`, `.rpm`, and `.AppImage`
- **Windows:** `.msi` (WiX) under `bundle/msi/` and `.exe` (NSIS) under `bundle/nsis/` when building on Windows

`npm run desktop` uses the shared native TTS build to keep release compilation/linking memory lower. On Linux, the build copies the sherpa-onnx shared libraries into the Tauri resource directory before bundling, and the app binary includes an rpath to `/usr/lib/Papercut` so installed `.deb`, `.rpm`, and AppImage builds can find those libraries at launch. If you specifically need a fully static native TTS build, use `npm run desktop:static`; that path can require substantially more RAM and may be killed by the OS on memory-constrained machines.

Install the generated Debian package with a dependency-aware command so WebKitGTK and GTK are installed if needed:

```bash
sudo apt install ./src-tauri/target/release/bundle/deb/Papercut_1.0.0_amd64.deb
```

If you previously used `sudo dpkg -i ...` and the app did not launch, run `sudo apt -f install` once to finish installing missing dependencies, then reinstall the newly generated `.deb`.

**AppImage troubleshooting:** `npm run desktop` sets `NO_STRIP=1` because the `linuxdeploy` tool used to bundle the AppImage can fail when its bundled `strip` cannot handle the host ELF format. If AppImage packaging reports `Could not find dependency: libwebkit2gtk-4.1.so.0`, the build is running in an environment that cannot see host WebKitGTK libraries. The desktop build wrapper handles Flatpak editor terminals by re-running the build on the host; outside Flatpak, install the Linux system dependencies above and rerun `npm run desktop`.

### Version bump checklist

For an app release, keep the frontend package version, Tauri bundle version, and Rust crate version in sync.

Update these files:

- `package.json` — React/frontend package version.
- `package-lock.json` — npm lockfile version metadata.
- `src-tauri/tauri.conf.json` — Tauri app/bundle version used by installers.
- `src-tauri/Cargo.toml` — Rust crate version.
- `src-tauri/Cargo.lock` — refreshed if Cargo records the local crate version change.

Suggested flow:

```bash
VERSION=1.0.1
npm version "$VERSION" --no-git-tag-version
```

Then set `version` to the same value in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --features native-tts-shared
npm run build
```

Commit the changed version files together with the release changes.

### Running the AppImage (Arch-based systems)

On Arch-based systems, the AppImage may show a blank screen due to a WebKit GBM buffer allocation failure with modern Mesa drivers. Set `WEBKIT_DISABLE_COMPOSITING_MODE=1` to disable GPU compositing:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./Papercut_1.0.0_amd64.AppImage
```

To avoid setting this every time, export it permanently in your shell:

```fish
set -Ux WEBKIT_DISABLE_COMPOSITING_MODE 1
```

### Android APK build

Before building for Android the first time, initialize the Android project (run once, commit the generated files):

```bash
npm run tauri -- android init
```

Then build the APK. The wrapper prepares/uses the local JDK and sets `JAVA_HOME` automatically:

```bash
npm run android:apk
```

Use `npm run android:apk:native-tts` when building the Android APK with native audiobook generation and background playback. Native playback uses Android Media3/ExoPlayer through the pinned `tauri-plugin-native-audio` dependency; API 26 is the minimum supported Android version.

Audiobooks are not pre-rendered into the APK. Users save full audiobooks on demand from the document UI, and generated audio is stored as local app user data.

The APK is output to:

```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The `--debug` flag signs the APK automatically with a debug keystore, which is required for sideloading. Unsigned release APKs are silently rejected by Android at install time.

To sideload on an Android device, enable **Install unknown apps** in Settings and transfer the `.apk` file directly (via USB, ADB, or file share).


### Android build troubleshooting

If Cargo prints `Blocking waiting for file lock on artifact directory`, another Rust/Tauri build is holding the target directory lock. Wait for the other build to finish, or stop the older terminal process and rerun the command. If no Cargo/Rust process is running, rerunning with a fresh terminal normally clears it.

### Offline native Kokoro text-to-speech

Papercut uses native sherpa-onnx for Kokoro TTS in desktop builds, and includes an arm64 Android native-TTS build path backed by the official sherpa-onnx Android shared libraries. The old browser-worker fallback has been removed; browser preview still works for document/search UI, but it cannot synthesize audio.

The Kokoro model is not packaged into desktop installers or Android APKs by default. Users install it once from the Audiobook settings cog with **Download voice model**. The app downloads the pinned official sherpa-onnx release asset into Tauri app data and verifies its SHA-256 before using it:

- Source: k2-fsa/sherpa-onnx Kokoro multi-lang v1.0
- URL: https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
- SHA-256: `c133d26353d776da730870dac7da07dbfc9a5e3bc80cc5e8e83ab6e823be7046`
- Archive size: about 333 MB

Desktop and Android use the same model archive. Only the native libraries are platform-specific: desktop builds use the Rust `sherpa-onnx` dependency, while Android native TTS uses the pinned sherpa-onnx Android shared-library archive prepared by `npm run prepare:sherpa-android-libs` and verified before extraction.

The process is documented in [docs/kokoro-tts.md](docs/kokoro-tts.md). Desktop scripts compile the `native-tts-shared` feature so speech generation runs through Tauri commands backed by sherpa-onnx without the high-memory static link step. For Android native TTS, run `npm run prepare:jdk`, `npm run prepare:sherpa-android-libs`, and then `npm run android:apk:native-tts`; the wrapper sets `JAVA_HOME` and `SHERPA_ONNX_LIB_DIR` automatically for arm64 builds and does not package model files into the APK.

Narration metadata is generated at runtime from the document HTML, whether the document is bundled or user-imported. Full audiobook audio is generated only when a user clicks Save for an HTML document. Full Save writes WAV chunks directly to native app data; playback is only available for complete saved or imported audiobooks. Desktop playback keeps a bounded chunk window. Android playback lazily creates one cached `playback.wav` plus chunk-boundary metadata and hands that local track to native Media3/ExoPlayer, so playback and media controls continue while the screen is locked. The derived track is reused until the audiobook is saved or imported again, and Delete Audiobook removes it with the rest of that audiobook directory. Generated audio is user data, not part of the app bundle.

Build helper scripts under `scripts/` are build orchestration, not a replacement for npm, Cargo, or Android SDK Manager. npm owns frontend tooling, Cargo owns Rust dependencies, and Android SDK Manager owns SDK/NDK installs. The scripts bridge the gaps: project paths, version constants, child-process execution, archive extraction, checked downloads, Android JDK/sherpa staging, Linux shared-library bundling, and Flatpak host-build delegation. OS-specific helpers live under `scripts/lib/android/` and `scripts/lib/linux/`.

The audio UI supports saved-only playback, Android background and lock-screen media controls, chunk-based Prev/Next navigation, a burger/list chunk jump menu for long audiobooks, per-chunk progress, current-chunk highlighting, native TTS thread-count tuning, a one-time voice model download button, an in-app TTS diagnostics panel, an Audiobooks panel for active/resumable/completed saves across voices, and a Saved audio filter for documents/search results.

### Browser build and preview

Build the frontend, generate the Pagefind index, then run the browser preview server with one command:

```bash
npm run browser
```

For CI or packaging steps that only need the built frontend artifacts, run:

```bash
npm run build
```

The `build` command is split into named stages for troubleshooting and CI reuse:

```bash
npm run build:typecheck
npm run build:vite
npm run build:search-index
```

</details>

## Adding Documents

Papercut now has two document paths:

- **Bundled documents** live in `public/documents/` and are indexed by Pagefind during the production build. This is still the best path for documents you ship to every user.
- **User uploads** are imported from the app UI and indexed incrementally into a local SQLite FTS database. This is the scalable path for documents users add themselves, because it does not require a rebuild or a packaged Pagefind index update.

The upload/indexing architecture is documented in [docs/user-document-search.md](docs/user-document-search.md).

<details>
<summary><strong>Document formats and search behavior</strong></summary>

### Bundled HTML Documents

Place your HTML files in `public/documents/`. Each document should have a standard HTML structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Your Document Title</title>
</head>
<body>
  <h1>Your Document Title</h1>
  <p>Your content here.</p>
</body>
</html>
```

Pagefind will automatically extract and index the text content on the next build. The `<title>` tag is used as the document title in search results.

### User-Uploaded HTML Documents

From the document list, open **Import** and choose **HTML** to select a local `.html` or `.htm` file. The native import path sanitizes and stores a copy of the HTML under Tauri app data, extracts readable sections, and indexes those sections into SQLite FTS5. Uploaded documents appear under **User Uploads**, open in the same reader as bundled HTML, participate in the same search UI, and can use the same TTS playback/save flow when native TTS is available. Uploaded HTML documents can also be deleted from the document list; delete removes the SQLite rows and the stored sanitized source file directory to free local storage.

This first upload branch is intentionally HTML-only. PDF and EPUB uploads should be added as separate parser modules that output the same normalized document sections before indexing.

### Search Behavior

Search is **explicit**: the app only searches when the user clicks the **Search** button next to the input or presses **Enter**. Typing does not trigger search. This keeps CPU and memory flat at scale (thousands of documents, large per-result fragment fetches). Bundled-document queries go through Pagefind, uploaded-document queries go through SQLite FTS5, and the React UI merges both result sets.

- Queries are lowercased before being passed to the search providers, making search case-insensitive regardless of how the user types it (`The quick brown fox jumped over the lazy dog` and `the quick brown fox jumped over the lazy dog` return the same results).
- Wrapping a phrase in double quotes (`"the quick brown fox jumped over the lazy dog"`) runs an **exact phrase** match for bundled Pagefind results. Pagefind itself does not support phrase syntax, so the app:
  1. Strips the quotes for the Pagefind call (term-matching to narrow the candidate set to ~50 docs).
  2. Fetches each candidate document via its URL, strips HTML tags, normalizes whitespace and curly quotes, lowercases, and checks for the phrase as a substring.
  3. Drops candidates that don't contain the phrase. Multiple quoted phrases in one query are ANDed together.
- The Pagefind `content` field on `result.data()` is unreliable for substring matching (truncated/normalized differently than the source), so phrase verification reads the actual file. Results are cached per URL in memory for the session to avoid re-fetching across queries.
- Clearing the input clears the results panel immediately, without triggering a search.
- In-flight stale results are dropped: if the user fires a new search before the previous one resolves, the earlier result set is discarded and never rendered.
- Uploaded-document snippets are produced by SQLite FTS and sanitized again before rendering in React. Uploaded matches are collapsed to one result card per uploaded document, using the first/best matching snippet; users can open the document and use in-document Find to move through additional matches.
- The "No documents found" message only appears after a search has actually been submitted (via Search button or Enter), not while the user is still typing.

</details>

## Flatpak Environment

<details>
<summary><strong>Flatpak development setup</strong></summary>

If running VS Code or Codium from a Flatpak, source the environment helper before running development Tauri commands:

```bash
source ./tauri-env.sh
npm run tauri:dev
```

This sets `PKG_CONFIG_PATH` and `PKG_CONFIG_SYSROOT_DIR` to point at the host system libraries mounted at `/run/host/`. Production desktop builds use `npm run desktop`, which delegates to the host automatically when Flatpak is detected so AppImage bundling can resolve host WebKitGTK dependencies.

</details>

## Project Structure

<details>
<summary><strong>Repository layout</strong></summary>

```
papercut.io/
├── public/documents/              # Bundled HTML documents indexed by Pagefind
├── src/                           # React frontend
│   ├── assets/                    # Bundled UI assets, including the header icon
│   ├── components/                # Reusable UI and reader/search/library panels
│   ├── hooks/                     # Shared React state hooks
│   ├── tts/                       # Audiobook API, components, hooks, storage, diagnostics
│   ├── uploads/                   # User-upload client API and types
│   ├── utils/                     # Search, formatting, document, and debug helpers
│   ├── viewers/                   # Document viewer registry and viewer implementations
│   ├── App.tsx                    # App shell and tab orchestration
│   ├── App.css                    # Main app styles
│   ├── index.css                  # Base styles
│   └── main.tsx                   # Entry point
├── src-tauri/                     # Tauri / Rust backend
│   ├── src/document_uploads/      # Runtime HTML upload + SQLite FTS indexing
│   ├── src/native_tts/            # Native sherpa-onnx TTS and audiobook bundles
│   ├── tts/model-manifest.json    # Pinned Kokoro model metadata
│   ├── tauri.conf.json            # Base Tauri config
│   └── tauri.linux.conf.json      # Linux shared-library bundle config
├── scripts/                       # Desktop/Android build orchestration
│   └── lib/                       # Shared and platform-specific script helpers
├── docs/                          # Feature and architecture notes
├── index.html                     # HTML shell
├── vite.config.ts                 # Vite configuration
├── package.json                   # Scripts and dependencies
└── tauri-env.sh                   # Flatpak development environment helper
```

</details>

## License

Papercut is available under the [MIT License](LICENSE.md).
