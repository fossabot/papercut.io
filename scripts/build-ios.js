import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SHERPA_IOS_DEVICE_SLICE, SHERPA_IOS_SIMULATOR_SLICE } from "./lib/ios/constants.js"
import { ensureIosSherpaLibs, iosSherpaLibDir } from "./lib/ios/sherpa.js"
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


if (ciCheck && initProject) {
  fail("Use either --ci-check or --init, not both.")
}

if (initProject) {
  runTauriIos(["ios", "init", ...extraArgs], "[ios-build] Failed to initialize Tauri iOS project: ")
} else {
  if (!existsSync(appleProjectDir)) {
    fail("Missing " + appleProjectDir + ". Run npm run ios:init on macOS, commit src-tauri/gen/apple, then rerun npm run ios:ipa.")
  }

  const env = { ...process.env }
  const featureArgs = []
  if (nativeTts) {
    const slice = ciCheck ? SHERPA_IOS_SIMULATOR_SLICE : SHERPA_IOS_DEVICE_SLICE
    await ensureIosSherpaLibs()
    env.SHERPA_ONNX_LIB_DIR = iosSherpaLibDir(slice)
    featureArgs.push("--features", "native-tts-static")
    console.log("[ios-build] native TTS enabled with SHERPA_ONNX_LIB_DIR=" + env.SHERPA_ONNX_LIB_DIR)
  }

  const args = ciCheck
    ? ["ios", "build", "--target", "aarch64-sim", ...featureArgs, ...extraArgs]
    : extraArgs.length > 0
      ? ["ios", "build", ...featureArgs, ...extraArgs]
      : ["ios", "build", "--export-method", "app-store-connect", ...featureArgs]

  runTauriIos(args, "[ios-build] Failed to build iOS IPA: ", env)
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

function runTauriIos(args, errorPrefix, env = process.env) {
  const { command, args: tauriArgs } = tauriCommand(args)
  const result = runSync(command, tauriArgs, { env })
  exitFromResult(result, errorPrefix)
}

function fail(message) {
  console.error("[ios-build] " + message)
  process.exit(1)
}
