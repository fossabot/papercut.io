import { currentDesktopPlatform, desktopBuildEnv, prepareDesktopBuild } from "./lib/desktop/platform.js"
import { runSync, exitFromResult } from "./lib/process.js"
import { tauriCommand } from "./lib/tauri.js"

const isStatic = process.argv.includes("--static")
const linkMode = isStatic ? "static" : "shared"
const feature = isStatic ? "native-tts-static" : "native-tts-shared"
const platform = currentDesktopPlatform()

prepareDesktopBuild(platform, { isStatic })
runTauriBuild(platform)

// Build with the selected native-TTS link mode using platform-specific env.
function runTauriBuild(platform) {
  const env = desktopBuildEnv(platform, {
    ...process.env,
    PAPERCUT_NATIVE_TTS_LINK: linkMode,
  })

  const { command, args } = tauriCommand(["build", "--features", feature])
  const result = runSync(command, args, { env })
  exitFromResult(result, "[desktop-build] Failed to start Tauri build: ")
}
