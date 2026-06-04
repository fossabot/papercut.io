export function prepareMacosDesktopBuild() {
  // macOS currently uses Tauri's standard app/DMG packaging path.
}

export function macosDesktopEnv(baseEnv) {
  return { ...baseEnv }
}
