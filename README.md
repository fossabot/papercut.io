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

Using [nvm](https://github.com/nvm-sh/nvm) (recommended):

```bash
nvm install 22
nvm use 22
```

### Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### System Dependencies (Linux)

Tauri requires the following system libraries on Linux (Ubuntu/Debian/Mint):

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file libssl-dev libxdo-dev
```

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

The built binary is output to `src-tauri/target/release/app`. Installers are generated in `src-tauri/target/release/bundle/` (`.deb` and `.rpm` on Linux).

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
