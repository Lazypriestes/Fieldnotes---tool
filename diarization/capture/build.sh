#!/usr/bin/env bash
# Compile the ScreenCaptureKit audio-capture helper.
#
# Produces a proper .app bundle (SystemAudio.app) with a STABLE bundle id, then a
# ./systemaudio symlink into it. The bundle id is what macOS ties the Screen-Recording
# permission to — so once you grant it, the grant survives rebuilds (a bare CLI binary
# loses its grant every recompile, because TCC keys an unbundled tool on its code hash).
#
# Needs Xcode command-line tools (swiftc).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/SystemAudio.app"
BID="com.fieldnotes.systemaudio"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "!! swiftc not found — install Xcode command-line tools:  xcode-select --install"
  exit 1
fi

echo "[build] compiling systemaudio (Core Audio process tap)"
mkdir -p "$APP/Contents/MacOS"

swiftc -O \
  -framework CoreAudio -framework AudioToolbox -framework AVFoundation \
  -o "$APP/Contents/MacOS/systemaudio" "$DIR/systemaudio.swift"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Fieldnotes System Audio</string>
  <key>CFBundleDisplayName</key><string>Fieldnotes System Audio</string>
  <key>CFBundleIdentifier</key><string>${BID}</string>
  <key>CFBundleExecutable</key><string>systemaudio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAudioCaptureUsageDescription</key><string>Fieldnotes captures system/Teams audio for live transcription.</string>
  <key>NSMicrophoneUsageDescription</key><string>Fieldnotes captures system/Teams audio for live transcription.</string>
</dict>
</plist>
PLIST

# Ad-hoc sign the bundle so it has a consistent on-disk identity.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

# Convenience symlink: ./systemaudio -> the executable INSIDE the bundle.
# Running it (even via the symlink) resolves to a path inside SystemAudio.app, so macOS
# attributes the capture to the bundle id — the whole point of bundling.
ln -sf "SystemAudio.app/Contents/MacOS/systemaudio" "$DIR/systemaudio"

echo "[build] done -> $APP  (symlinked as ./systemaudio)"
echo "        Captures system audio via a Core Audio process tap — no driver, no output"
echo "        rerouting. If macOS asks, allow audio recording for 'Fieldnotes System Audio'"
echo "        (any grant is tied to the stable bundle id ${BID}, so it survives rebuilds)."
