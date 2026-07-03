import { existsSync } from "node:fs"
import { cp, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  SHERPA_MACOS_OPTIONAL_LIBS,
  SHERPA_MACOS_REQUIRED_LIBS,
  SHERPA_MACOS_SHARED_OUT_DIR,
  SHERPA_MACOS_SHARED_SOURCE_DIR,
} from "./constants.js"

// Shared-link macOS desktop builds bundle sherpa dylibs as Tauri resources so
// the app's @loader_path/../Resources rpath resolves inside the .app bundle.
export async function copyMacosSherpaLibs({ platform = process.env.TAURI_ENV_PLATFORM, linkMode = process.env.PAPERCUT_NATIVE_TTS_LINK } = {}) {
  if (platform && platform !== "macos") return
  if (linkMode === "static") return

  await assertMacosSharedLibsExist()
  await mkdir(SHERPA_MACOS_SHARED_OUT_DIR, { recursive: true })

  for (const lib of [...SHERPA_MACOS_REQUIRED_LIBS, ...SHERPA_MACOS_OPTIONAL_LIBS]) {
    const source = join(SHERPA_MACOS_SHARED_SOURCE_DIR, lib)
    if (existsSync(source)) {
      await cp(source, join(SHERPA_MACOS_SHARED_OUT_DIR, lib), { force: true })
    }
  }

  console.log("[sherpa-macos-libs] bundled shared libraries from " + SHERPA_MACOS_SHARED_SOURCE_DIR)
}

// Fail with build guidance instead of producing an installer missing runtime libs.
async function assertMacosSharedLibsExist() {
  for (const lib of SHERPA_MACOS_REQUIRED_LIBS) {
    try {
      const info = await stat(join(SHERPA_MACOS_SHARED_SOURCE_DIR, lib))
      if (!info.isFile()) throw new Error(lib + " is not a file")
    } catch (err) {
      throw new Error(
        "Missing " + lib + " at " + SHERPA_MACOS_SHARED_SOURCE_DIR + ". Build with --features native-tts-shared so sherpa-onnx downloads its macOS shared library archive before bundling. " + err,
      )
    }
  }
}
