# Papercut

A lightweight desktop application for full-text search across document collections. Built with Tauri, React, Vite, Pagefind, and SQLite FTS.

Bundled documents are indexed at build time using Pagefind, which creates a compressed search index. User-imported HTML documents are indexed at runtime into a local SQLite FTS database in Tauri app data, so users can add their own documents without rebuilding the app. At runtime, only the relevant search provider is queried and results are merged into one UI. The entire application runs offline with no server or internet connection required.

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

Papercut now has two document paths:

- **Bundled documents** live in `public/documents/` and are indexed by Pagefind during the production build. This is still the best path for documents you ship to every user.
- **User uploads** are imported from the app UI and indexed incrementally into a local SQLite FTS database. This is the scalable path for documents users add themselves, because it does not require a rebuild or a packaged Pagefind index update.

The upload/indexing architecture is documented in [docs/user-document-search.md](docs/user-document-search.md).

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

- Queries are lowercased before being passed to the search providers, making search case-insensitive regardless of how the user types it (`Highest Stage of Capitalism` and `highest stage of capitalism` return the same results).
- Wrapping a phrase in double quotes (`"highest stage of capitalism"`) runs an **exact phrase** match for bundled Pagefind results. Pagefind itself does not support phrase syntax, so the app:
  1. Strips the quotes for the Pagefind call (term-matching to narrow the candidate set to ~50 docs).
  2. Fetches each candidate document via its URL, strips HTML tags, normalizes whitespace and curly quotes, lowercases, and checks for the phrase as a substring.
  3. Drops candidates that don't contain the phrase. Multiple quoted phrases in one query are ANDed together.
- The Pagefind `content` field on `result.data()` is unreliable for substring matching (truncated/normalized differently than the source), so phrase verification reads the actual file. Results are cached per URL in memory for the session to avoid re-fetching across queries.
- Clearing the input clears the results panel immediately, without triggering a search.
- In-flight stale results are dropped: if the user fires a new search before the previous one resolves, the earlier result set is discarded and never rendered.
- Uploaded-document snippets are produced by SQLite FTS and sanitized again before rendering in React. Uploaded matches are collapsed to one result card per uploaded document, using the first/best matching snippet; users can open the document and use in-document Find to move through additional matches.
- The "No documents found" message only appears after a search has actually been submitted (via Search button or Enter), not while the user is still typing.

## Flatpak Environment

If running VS Code or Codium from a Flatpak, source the environment helper before running development Tauri commands:

```bash
source ./tauri-env.sh
npm run tauri:dev
```

This sets `PKG_CONFIG_PATH` and `PKG_CONFIG_SYSROOT_DIR` to point at the host system libraries mounted at `/run/host/`.

## Project Structure

```
papercut.io/
├── public/documents/        # HTML documents to index
├── src/                     # React frontend
│   ├── App.tsx              # App shell — wires hooks to components, no business logic
│   ├── App.css              # Global styles
│   ├── index.css            # Base styles
│   ├── main.tsx             # Entry point
│   ├── types/               # Shared TypeScript interfaces
│   │   └── search.ts        # SearchResult, DocumentInfo, PagefindInstance
│   ├── utils/               # Pure, React-free helpers (unit-testable)
│   │   ├── textUtils.ts     # Normalize / escape helpers
│   │   ├── documentUtils.ts # deriveAuthor, extractPageFromAnchor
│   │   └── phraseSearch.ts  # Exact-phrase fetch cache, excerpt building
│   ├── hooks/               # Stateful logic, one concern per hook
│   │   ├── usePagefind.ts   # Loads the index, exposes all documents
│   │   ├── useSearch.ts     # Query, results, exact-phrase filtering
│   │   ├── useDocumentFilters.ts # Author grouping + filter selection
│   │   └── useFindInPage.ts # In-document find/highlight + Ctrl+F
│   ├── components/          # Presentational UI components
│   │   ├── SearchBar/
│   │   ├── SearchResults/
│   │   ├── DocumentsPanel/
│   │   ├── DocumentViewer/  # Hosts the resolved viewer + find bar
│   │   ├── FindBar/
│   │   └── ScrollTopButton/
│   └── viewers/             # Pluggable document viewers (see below)
│       ├── types.ts         # ViewerPlugin / ViewerProps contracts
│       ├── registry.ts      # resolveViewer(url) → picks a viewer
│       ├── HtmlViewer.tsx   # Active — renders HTML in a sandboxed iframe
│       ├── PdfViewer.tsx    # Stub — ready for pdf.js
│       └── EpubViewer.tsx   # Stub — ready for epub.js
├── src-tauri/               # Tauri / Rust backend
├── index.html               # HTML shell
├── vite.config.ts           # Vite configuration
├── package.json             # Scripts and dependencies
└── tauri-env.sh             # Flatpak environment helper
```

## Architecture

The frontend is organized in three layers so features can be added without touching unrelated logic. Dependencies only ever point downward: components use hooks, hooks use utils, utils depend on nothing.

1. **Utils** (`src/utils/`) — Pure functions with no React imports. Text normalization, author derivation, and the exact-phrase search (which fetches document text, caches it at module level, and builds highlighted excerpts). Because they are side-effect-free, they are the easiest layer to unit-test.

2. **Hooks** (`src/hooks/`) — Each hook owns one slice of state and its side effects. `usePagefind` loads the search index; `useSearch` runs queries and applies exact-phrase filtering with race-condition guards; `useDocumentFilters` groups documents by author and tracks filter selection; `useFindInPage` drives in-document highlighting and registers its own `Ctrl+F` / `Escape` listeners.

3. **Components** (`src/components/`) — Presentational pieces that receive data and callbacks via props. `App.tsx` is the only place that composes hooks together; everything else just renders.

### Document viewer plugins

`DocumentViewer` does not know how to render any specific file type. Instead it asks the registry which viewer handles a given URL. Each viewer file (`HtmlViewer.tsx`, `PdfViewer.tsx`, `EpubViewer.tsx`) exports only a React component; the registry maps each component to a `canHandle` predicate:

```ts
// src/viewers/registry.ts
const viewerPlugins: ViewerPlugin[] = [
  { id: 'pdf',  canHandle: (url) => /\.pdf$/i.test(url),  Component: PdfViewer },
  { id: 'epub', canHandle: (url) => /\.epub$/i.test(url), Component: EpubViewer },
  htmlPlugin, // canHandle: () => true — catch-all fallback
]

export function resolveViewer(url: string): ViewerPlugin {
  return viewerPlugins.find((p) => p.canHandle(url)) ?? htmlPlugin
}
```

Keeping components and descriptors separate lets Vite's fast refresh work (component files export only components) and centralizes URL resolution in one place. The plugin contract:

```ts
// src/viewers/types.ts
export interface ViewerPlugin {
  id: string
  canHandle: (url: string) => boolean
  Component: React.FC<ViewerProps>
}
```

Order matters — more specific formats are listed before the catch-all HTML fallback. To **add support for a new document type** (e.g. PDF):

1. Implement the component in `src/viewers/PdfViewer.tsx` (the stub is already exported).
2. Register it in `registry.ts` with a `canHandle` predicate (the `pdf` / `epub` entries are already wired). No changes to `App.tsx` or `DocumentViewer` are required.

If a viewer needs extra capabilities (PDF zoom, page scroll callbacks, etc.), widen the `ViewerProps` interface with optional fields so existing viewers stay unaffected.
