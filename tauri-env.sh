#!/bin/sh
# Source this file before running Tauri commands from within a Flatpak environment.
# Usage: source ./tauri-env.sh && npm run tauri:dev
export PKG_CONFIG_PATH="/run/host/usr/lib/x86_64-linux-gnu/pkgconfig:/run/host/usr/share/pkgconfig:/run/host/usr/lib/pkgconfig:/run/host/usr/local/lib/x86_64-linux-gnu/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="/run/host"

# Load nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Load cargo/rust if available
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
[ -f "$HOME/.var/app/com.vscodium.codium/data/cargo/env" ] && . "$HOME/.var/app/com.vscodium.codium/data/cargo/env"
