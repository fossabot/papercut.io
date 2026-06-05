export function prepareWindowsDesktopBuild() {
  // Windows currently uses Tauri's standard MSI/NSIS packaging path.
}

export function windowsDesktopEnv(baseEnv) {
  return { ...baseEnv }
}
