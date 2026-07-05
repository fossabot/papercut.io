import { join } from "node:path"
import { SHERPA_VERSION } from "../constants.js"
import { fromRuntime } from "../paths.js"

export { SHERPA_VERSION }

export const SHERPA_IOS_RUNTIME_ROOT = fromRuntime("sherpa-onnx-ios")
export const SHERPA_IOS_ARCHIVE_NAME = "sherpa-onnx-v" + SHERPA_VERSION + "-ios.tar.bz2"
export const SHERPA_IOS_ARCHIVE = join(SHERPA_IOS_RUNTIME_ROOT, SHERPA_IOS_ARCHIVE_NAME)
export const SHERPA_IOS_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v" +
  SHERPA_VERSION +
  "/" +
  SHERPA_IOS_ARCHIVE_NAME
export const SHERPA_IOS_SHA256 = "2886a04df4f8d5066c6c8b6e712278d65d7b60fc9e45990223df50262861d38b"

export const SHERPA_IOS_DEVICE_SLICE = "ios-arm64"
export const SHERPA_IOS_SIMULATOR_SLICE = "ios-arm64_x86_64-simulator"
export const SHERPA_IOS_DEFAULT_SLICE = SHERPA_IOS_DEVICE_SLICE

export const SHERPA_IOS_BUILD_ROOT = join(SHERPA_IOS_RUNTIME_ROOT, "build-ios")
export const SHERPA_IOS_SHERPA_XCFRAMEWORK = join(SHERPA_IOS_BUILD_ROOT, "sherpa-onnx.xcframework")
export const SHERPA_IOS_ONNXRUNTIME_XCFRAMEWORK = join(
  SHERPA_IOS_BUILD_ROOT,
  "ios-onnxruntime",
  "1.17.1",
  "onnxruntime.xcframework",
)

export const SHERPA_IOS_CARGO_LIBS = [
  "sherpa-onnx-c-api",
  "sherpa-onnx-core",
  "kaldi-decoder-core",
  "sherpa-onnx-kaldifst-core",
  "sherpa-onnx-fstfar",
  "sherpa-onnx-fst",
  "kaldi-native-fbank-core",
  "kissfft-float",
  "piper_phonemize",
  "espeak-ng",
  "ucd",
  "onnxruntime",
  "ssentencepiece_core",
]
