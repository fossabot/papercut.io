import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { exitFromResult, runSync } from "./lib/process.js"
import { SRC_TAURI_DIR } from "./lib/paths.js"
import { tauriCommand } from "./lib/tauri.js"

const initProject = process.argv.includes("--init")
const nativeTts = process.argv.includes("--native-tts")
const ciCheck = process.argv.includes("--ci-check")
const extraArgs = process.argv.slice(2).filter((arg) => arg !== "--init" && arg !== "--native-tts" && arg !== "--ci-check")
const appleProjectDir = join(SRC_TAURI_DIR, "gen", "apple")
const iosConfigPath = join(SRC_TAURI_DIR, "tauri.ios.conf.json")
const expectedIosBundleId = "io.papercut.app"

verifyIosBundleId()

if (process.platform !== "darwin") {
  fail("iOS builds require macOS with full Xcode. Use a GitHub macos-15 runner or MacInCloud; Linux cannot run tauri ios build.")
}

if (nativeTts) {
  fail("iOS native TTS is not wired yet. First ship the signed/TestFlight iOS build, then add sherpa iOS static-library support.")
}

if (ciCheck && initProject) {
  fail("Use either --ci-check or --init, not both.")
}

if (initProject) {
  runTauriIos(["ios", "init", ...extraArgs], "[ios-build] Failed to initialize Tauri iOS project: ")
} else {
  if (!existsSync(appleProjectDir)) {
    fail("Missing " + appleProjectDir + ". Run npm run ios:init on macOS, commit src-tauri/gen/apple, then rerun npm run ios:ipa.")
  }

  const args = ciCheck
    ? ["ios", "build", "--target", "aarch64-sim", ...extraArgs]
    : extraArgs.length > 0
      ? ["ios", "build", ...extraArgs]
      : ["ios", "build", "--export-method", "app-store-connect"]

  runTauriIos(args, "[ios-build] Failed to build iOS IPA: ")
}

function verifyIosBundleId() {
  if (!existsSync(iosConfigPath)) {
    fail("Missing iOS Tauri config: " + iosConfigPath)
  }

  const config = JSON.parse(readFileSync(iosConfigPath, "utf8"))
  if (config.identifier !== expectedIosBundleId) {
    fail("Expected iOS Bundle ID " + expectedIosBundleId + " in " + iosConfigPath + ", got " + config.identifier)
  }
}

function runTauriIos(args, errorPrefix) {
  const { command, args: tauriArgs } = tauriCommand(args)
  const result = runSync(command, tauriArgs)
  exitFromResult(result, errorPrefix)
}

function fail(message) {
  console.error("[ios-build] " + message)
  process.exit(1)
}
