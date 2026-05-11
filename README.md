# Papercut

A lightweight desktop application for full-text search across HTML document collections. Built with Tauri, React, Vite, and Pagefind.

Documents are indexed at build time using Pagefind, which creates a compressed search index. At runtime, only the relevant portions of the index are loaded into memory, keeping the application fast and responsive even with large document collections. The entire application runs offline with no server or internet connection required.

## Prerequisites

| Tool  | Minimum Version | Recommended Version |
|-------|-----------------|---------------------|
| Node  | >= 22.12.0      | 22.22.1             |
| npm   | >= 10.9.0       | 10.9.4              |
| Rust  | >= 1.77.2       | 1.94.0              |
| Cargo | >= 1.77.2       | 1.94.0              |

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
| Android SDK | API 24+         |
| Android NDK | 29.0.13846066   |

**Install Java 17:**

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

## Getting Started

### Install dependencies

```bash
npm install
```

### Development

```bash
npm run tauri:dev
```

This starts the Vite dev server and launches the Tauri desktop window with hot reload. Note that the Pagefind search index is only available after a full build, so search will not work in dev mode.

### Production build

```bash
npm run tauri:build
```

This runs the full pipeline:

1. TypeScript compilation and Vite build
2. Pagefind indexes all HTML documents in `public/documents/`
3. Tauri compiles the Rust backend and bundles the desktop application

The built binary is output to `src-tauri/target/release/app` (`app.exe` on Windows). Installers are generated in `src-tauri/target/release/bundle/`:

- **Linux:** `.deb`, `.rpm`, and `.AppImage`
- **Windows:** `.msi` (WiX) under `bundle/msi/` and `.exe` (NSIS) under `bundle/nsis/`

**Arch-based systems:** The `linuxdeploy` tool used to bundle the AppImage contains an old `strip` binary that cannot handle Arch's newer ELF format. Prefix the build command with `NO_STRIP=1` to skip stripping:

```bash
NO_STRIP=1 npm run tauri:build
```

To avoid typing this every time, set it permanently in your shell:

```fish
set -Ux NO_STRIP 1
```

### Running the AppImage (Arch-based systems)

On Arch-based systems, the AppImage may show a blank screen due to a WebKit GBM buffer allocation failure with modern Mesa drivers. Set `WEBKIT_DISABLE_COMPOSITING_MODE=1` to disable GPU compositing:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./Papercut_0.1.0_amd64.AppImage
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

Then build the APK:

```bash
npm run tauri:android:build
```

The APK is output to:

```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The `--debug` flag signs the APK automatically with a debug keystore, which is required for sideloading. Unsigned release APKs are silently rejected by Android at install time.

To sideload on an Android device, enable **Install unknown apps** in Settings and transfer the `.apk` file directly (via USB, ADB, or file share).

### Frontend-only build

To build just the frontend and generate the Pagefind index without compiling the Tauri binary:

```bash
npm run build
```

You can then preview the frontend in a browser:

```bash
npm run preview
```

## Adding Documents

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

## Flatpak Environment

If running VS Code or Codium from a Flatpak, source the environment helper before running Tauri commands:

```bash
source ./tauri-env.sh
npm run tauri:dev
```

This sets `PKG_CONFIG_PATH` and `PKG_CONFIG_SYSROOT_DIR` to point at the host system libraries mounted at `/run/host/`.

## Project Structure

```
papercut.io/
├── public/documents/     # HTML documents to index
├── src/                  # React frontend
│   ├── App.tsx           # Search UI
│   ├── App.css           # Styles
│   ├── index.css         # Base styles
│   └── main.tsx          # Entry point
├── src-tauri/            # Tauri / Rust backend
├── index.html            # HTML shell
├── vite.config.ts        # Vite configuration
├── package.json          # Scripts and dependencies
└── tauri-env.sh          # Flatpak environment helper
```
