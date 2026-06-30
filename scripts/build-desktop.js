import { currentDesktopPlatform, desktopBuildEnv, prepareDesktopBuild } from "./lib/desktop/platform.js"
import { runSync, exitFromResult } from "./lib/process.js"
import { tauriCommand } from "./lib/tauri.js"

const isStatic = process.argv.includes("--static")
const translationEnabled = !process.argv.includes("--no-translation")
const linkMode = isStatic ? "static" : "shared"
const platform = currentDesktopPlatform()

prepareDesktopBuild(platform, { isStatic })
runTauriBuild(platform)

// Build with native TTS plus desktop CTranslate2 translation by default.
//
// `--no-translation` is intentionally a script-level escape hatch for isolating
// desktop packaging or TTS regressions; the normal desktop build should exercise
// the same end-to-end translation path users receive.
function runTauriBuild(platform) {
  const env = desktopBuildEnv(platform, {
    ...process.env,
    PAPERCUT_NATIVE_TTS_LINK: linkMode,
  })
  const features = [
    ...nativeTtsFeatures({ isStatic }),
    ...nativeTranslationFeatures({ enabled: translationEnabled }),
  ]

  console.log("[desktop-build] features=" + features.join(","))
  const { command, args } = tauriCommand(["build", "--features", features.join(",")])
  const result = runSync(command, args, { env })
  exitFromResult(result, "[desktop-build] Failed to start Tauri build: ")
}

// Native TTS has two desktop link modes. Shared is the default release path
// because it keeps compile/link memory lower; static remains available for
// builders that explicitly need one self-contained Rust artifact.
function nativeTtsFeatures({ isStatic }) {
  return [isStatic ? "native-tts-static" : "native-tts-shared"]
}

// Translation is independent of TTS. Keep it in its own feature helper so
// CTranslate2 packaging can be disabled for diagnosis without changing the
// native TTS build mode or the rest of the desktop wrapper.
function nativeTranslationFeatures({ enabled }) {
  return enabled ? ["native-translation-ctranslate2"] : []
}
