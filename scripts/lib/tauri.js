import { join } from "node:path"
import { ROOT } from "./paths.js"

// Invoke the installed Tauri CLI with Node so Windows does not depend on .cmd shims.
export function tauriCommand(args) {
  return {
    command: process.execPath,
    args: [
      join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js"),
      ...args,
    ],
  }
}
