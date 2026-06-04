import { existsSync, mkdirSync } from "node:fs"
import { NODE_VERSION } from "./lib/constants.js"
import { SHERPA_LINUX_SHARED_OUT_DIR } from "./lib/linux/constants.js"
import { npxBin, runSync, shQuote, exitFromResult } from "./lib/process.js"

const isStatic = process.argv.includes("--static")
const linkMode = isStatic ? "static" : "shared"
const feature = isStatic ? "native-tts-static" : "native-tts-shared"

if (isFlatpak() && !process.env.PAPERCUT_HOST_BUILD) {
  delegateToHost()
} else {
  runTauriBuild()
}

// Detect sandboxed editor terminals that cannot see host WebKitGTK/GTK.
function isFlatpak() {
  return existsSync("/.flatpak-info") || Boolean(process.env.FLATPAK_ID)
}

// Re-run desktop packaging on the host so linuxdeploy can resolve host libs.
function delegateToHost() {
  const npmScript = isStatic ? "desktop:static" : "desktop"
  const command = `
set -eu
cd ${shQuote(process.cwd())}
# tauri-env.sh sets Flatpak pkg-config paths for direct in-sandbox Tauri
# commands. The delegated desktop build runs on the host, so remove those
# paths before compiling and before linuxdeploy probes host WebKitGTK/GTK.
unset PKG_CONFIG_PATH
unset PKG_CONFIG_SYSROOT_DIR
unset PKG_CONFIG_LIBDIR
export PAPERCUT_HOST_BUILD=1
export NO_STRIP=1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if command -v nvm >/dev/null 2>&1; then
  nvm use ${NODE_VERSION} >/dev/null
fi
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
npm run ${npmScript}
`.trim()

  console.log("[desktop-build] Flatpak environment detected; running the desktop build on the host OS so linuxdeploy can resolve WebKitGTK.")
  const result = runSync("flatpak-spawn", ["--host", "bash", "-lc", command])
  exitFromResult(result, "[desktop-build] Failed to start host build: ")
}

// Build with the selected native-TTS link mode and AppImage strip workaround.
function runTauriBuild() {
  ensureLinuxSharedResourceDir()

  const command = npxBin()
  const env = {
    ...process.env,
    NO_STRIP: process.env.NO_STRIP ?? "1",
    PAPERCUT_NATIVE_TTS_LINK: linkMode,
  }

  const result = runSync(command, ["tauri", "build", "--features", feature], { env })
  exitFromResult(result, "[desktop-build] Failed to start Tauri build: ")
}

// Linux config always declares the shared-lib resource dir, even for static builds.
function ensureLinuxSharedResourceDir() {
  if (process.platform !== "linux") return

  // Tauri validates configured resource paths before bundle hooks run, so the
  // gitignored directory must exist even when the selected link mode is static.
  mkdirSync(SHERPA_LINUX_SHARED_OUT_DIR, { recursive: true })
}
