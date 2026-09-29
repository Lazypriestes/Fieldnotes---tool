#!/usr/bin/env bash
# Compile the ScreenCaptureKit audio-capture helper.
# Produces ./systemaudio next to this script. Needs Xcode command-line tools (swiftc).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "!! swiftc not found — install Xcode command-line tools:  xcode-select --install"
  exit 1
fi

echo "[build] compiling systemaudio (ScreenCaptureKit)…"
swiftc -O \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia \
  -o "$DIR/systemaudio" "$DIR/systemaudio.swift"
echo "[build] done -> $DIR/systemaudio"
echo "        first run asks for Screen-Recording permission for your terminal."
