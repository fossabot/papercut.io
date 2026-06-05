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

# Prefer the repo-local JDK prepared by npm run prepare:jdk when present.
PAPERCUT_LOCAL_JDK="$PWD/src-tauri/tts/runtime/jdk/temurin-17"
if [ -x "$PAPERCUT_LOCAL_JDK/bin/java" ]; then
  export JAVA_HOME="$PAPERCUT_LOCAL_JDK"
  export PATH="$JAVA_HOME/bin:$PATH"
fi
