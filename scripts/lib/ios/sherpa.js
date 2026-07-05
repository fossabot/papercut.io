import { cp, link, mkdir, realpath, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { extractTar } from "../archive.js"
import { downloadFile } from "../download.js"
import {
  SHERPA_IOS_ARCHIVE,
  SHERPA_IOS_CARGO_LIBS,
  SHERPA_IOS_DEFAULT_SLICE,
  SHERPA_IOS_ONNXRUNTIME_XCFRAMEWORK,
  SHERPA_IOS_RUNTIME_ROOT,
  SHERPA_IOS_SHA256,
  SHERPA_IOS_SHERPA_XCFRAMEWORK,
  SHERPA_IOS_URL,
  SHERPA_IOS_DEVICE_SLICE,
  SHERPA_IOS_SIMULATOR_SLICE,
} from "./constants.js"

export function iosSherpaLibDir(slice = SHERPA_IOS_DEFAULT_SLICE) {
  return join(SHERPA_IOS_RUNTIME_ROOT, "cargo-libs", slice)
}

export async function ensureIosSherpaLibs({ force = false } = {}) {
  await mkdir(SHERPA_IOS_RUNTIME_ROOT, { recursive: true })
  if (force) {
    await rm(SHERPA_IOS_RUNTIME_ROOT, { recursive: true, force: true })
    await mkdir(SHERPA_IOS_RUNTIME_ROOT, { recursive: true })
  }

  if (!await hasIosArchiveLibs()) {
    await downloadFile({
      url: SHERPA_IOS_URL,
      dest: SHERPA_IOS_ARCHIVE,
      force,
      sha256: SHERPA_IOS_SHA256,
      label: "sherpa-ios-libs",
    })
    await extractIosArchive()
    await rm(SHERPA_IOS_ARCHIVE, { force: true })
  }

  if (!await hasIosArchiveLibs()) {
    throw new Error("Downloaded sherpa-onnx iOS archive is missing required XCFramework static libraries")
  }

  await syncCargoLibAliases(SHERPA_IOS_DEVICE_SLICE)
  await syncCargoLibAliases(SHERPA_IOS_SIMULATOR_SLICE)
  console.log("[sherpa-ios-libs] ready " + join(SHERPA_IOS_RUNTIME_ROOT, "cargo-libs"))
}

async function hasIosArchiveLibs() {
  return await isFile(sherpaArchiveLib(SHERPA_IOS_DEVICE_SLICE)) &&
    await isFile(sherpaArchiveLib(SHERPA_IOS_SIMULATOR_SLICE)) &&
    await isFile(onnxRuntimeArchiveLib(SHERPA_IOS_DEVICE_SLICE)) &&
    await isFile(onnxRuntimeArchiveLib(SHERPA_IOS_SIMULATOR_SLICE))
}

async function extractIosArchive() {
  console.log("[sherpa-ios-libs] extracting " + SHERPA_IOS_ARCHIVE)
  await extractTar({ archive: SHERPA_IOS_ARCHIVE, destination: SHERPA_IOS_RUNTIME_ROOT, compression: "bzip2" })
}

async function syncCargoLibAliases(slice) {
  const target = iosSherpaLibDir(slice)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  const sherpaLib = sherpaArchiveLib(slice)
  const onnxRuntimeLib = onnxRuntimeArchiveLib(slice)
  for (const lib of SHERPA_IOS_CARGO_LIBS) {
    const source = lib === "onnxruntime" ? onnxRuntimeLib : sherpaLib
    await linkOrCopy(source, join(target, "lib" + lib + ".a"))
  }
}

function sherpaArchiveLib(slice) {
  return join(SHERPA_IOS_SHERPA_XCFRAMEWORK, slice, "libsherpa-onnx.a")
}

function onnxRuntimeArchiveLib(slice) {
  return join(SHERPA_IOS_ONNXRUNTIME_XCFRAMEWORK, slice, "libonnxruntime.a")
}

async function linkOrCopy(source, target) {
  await rm(target, { force: true })
  const resolvedSource = await realpath(source)
  try {
    await link(resolvedSource, target)
  } catch {
    await cp(resolvedSource, target, { force: true })
  }
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
