#!/data/data/com.termux/files/usr/bin/bash
# Installs the edge stack (gateway + MediaMTX) on a SIYI UniRC 7 Pro, inside Termux.
# Run once from the copied kit folder:   bash install.sh
# Safe to run again: it keeps an existing ~/edge/site.json and an installed MediaMTX.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
EDGE="$HOME/edge"
MTX_VERSION=v1.9.3
MTX_FILE="mediamtx_${MTX_VERSION}_linux_arm64v8.tar.gz"
MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/${MTX_FILE}"
MTX_SIZE=18499416 # bytes, from the GitHub release (no checksum file is published for this release)

echo "--- check: Termux on 64-bit ARM"
arch="$(uname -m)"
if [ "$arch" != "aarch64" ]; then echo "This kit needs aarch64 (64-bit ARM); this device is $arch."; exit 1; fi

echo "--- packages (Node.js LTS, curl, tar, procps)"
pkg update -y
pkg install -y nodejs-lts curl tar procps
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then echo "Node $(node --version) is too old; need 22 or newer."; exit 1; fi
echo "Node $(node --version)"

echo "--- files into $EDGE"
mkdir -p "$EDGE/bin" "$EDGE/data" "$EDGE/logs"
cp "$KIT/edge-gateway.mjs" "$KIT/mediamtx.android.yml" "$KIT/start.sh" "$KIT/stop.sh" "$KIT/status.sh" "$EDGE/"
[ -f "$KIT/VERSION" ] && cp "$KIT/VERSION" "$EDGE/"
if [ -f "$EDGE/site.json" ]; then
  echo "keeping the existing $EDGE/site.json"
else
  cp "$KIT/site.remote.example.json" "$EDGE/site.json"
fi
chmod +x "$EDGE/start.sh" "$EDGE/stop.sh" "$EDGE/status.sh"

echo "--- MediaMTX $MTX_VERSION (linux arm64)"
if [ -x "$EDGE/bin/mediamtx" ]; then
  echo "already installed"
else
  curl -fL --retry 3 -o "$EDGE/bin/$MTX_FILE" "$MTX_URL"
  size="$(stat -c %s "$EDGE/bin/$MTX_FILE")"
  if [ "$size" != "$MTX_SIZE" ]; then echo "Download has $size bytes, expected $MTX_SIZE. Not installing."; rm -f "$EDGE/bin/$MTX_FILE"; exit 1; fi
  tar -xzf "$EDGE/bin/$MTX_FILE" -C "$EDGE/bin" mediamtx
  rm -f "$EDGE/bin/$MTX_FILE"
  chmod +x "$EDGE/bin/mediamtx"
fi

echo
echo "Installed. Next (guide: README_TH.md):"
echo "  1. nano $EDGE/site.json            key, geo, REMOTE_IP"
echo "  2. nano $EDGE/mediamtx.android.yml REMOTE_IP"
echo "  3. $EDGE/start.sh"
