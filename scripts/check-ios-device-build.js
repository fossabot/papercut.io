import { cp, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { ensureIosSherpaLibs } from "./lib/ios/sherpa.js"
import { exitFromResult, runSync } from "./lib/process.js"
import { ROOT, SRC_TAURI_DIR } from "./lib/paths.js"

const appleProjectDir = join(SRC_TAURI_DIR, "gen", "apple")
const assetsDir = join(appleProjectDir, "assets")
const distDir = join(ROOT, "dist")

if (process.platform !== "darwin") {
  fail("iOS device checks require macOS with full Xcode. Use a GitHub macos-26 runner or MacInCloud.")
}

await ensureIosSherpaLibs({ includeSimulator: false })
await ensureAssets()

const args = [
  "-project",
  "app.xcodeproj",
  "-scheme",
  "app_iOS",
  "-configuration",
  "release",
  "-sdk",
  "iphoneos",
  "-destination",
  "generic/platform=iOS",
  "CODE_SIGNING_ALLOWED=NO",
  "CODE_SIGNING_REQUIRED=NO",
  "CODE_SIGN_IDENTITY=",
  "DEVELOPMENT_TEAM=",
  "build",
]

const result = runSync("xcodebuild", args, { cwd: appleProjectDir })
exitFromResult(result, "[ios-device-check] Failed unsigned iOS device build: ")

async function ensureAssets() {
  if (await isDir(assetsDir)) {
    return
  }
  if (!await isDir(distDir)) {
    fail("Missing frontend dist. Run npm run build before ios:ci:device.")
  }
  await mkdir(appleProjectDir, { recursive: true })
  await cp(distDir, assetsDir, { recursive: true })
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function fail(message) {
  console.error("[ios-device-check] " + message)
  process.exit(1)
}
