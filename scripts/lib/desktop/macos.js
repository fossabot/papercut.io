import { mkdirSync } from "node:fs"
import { SHERPA_MACOS_SHARED_OUT_DIR, SHERPA_MACOS_SHARED_SOURCE_DIR } from "../macos/constants.js"

export function prepareMacosDesktopBuild() {
  // Tauri validates configured resource paths before bundle hooks run, so the
  // gitignored staging directory must exist even before the beforeBundleCommand copies dylibs.
  mkdirSync(SHERPA_MACOS_SHARED_OUT_DIR, { recursive: true })
}

// ORT_LIB_LOCATION points ort-sys at the sherpa-onnx packaged ONNX Runtime so
// desktop shares one libonnxruntime across sherpa and Libtashkeel, matching Linux.
export function macosDesktopEnv(baseEnv) {
  return {
    ...baseEnv,
    ORT_LIB_LOCATION: baseEnv.ORT_LIB_LOCATION ?? SHERPA_MACOS_SHARED_SOURCE_DIR,
  }
}
