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

echo "--- packages (Node.js LTS, curl, tar, procps, ffmpeg)"
# Full upgrade first, with apt itself: a new Node.js needs the current libc++ and OpenSSL. A
# partial upgrade broke both node and curl on a UniRC 7 Pro (2026-10-27): 'CANNOT LINK EXECUTABLE
# ... cannot locate symbol', and then pkg (which runs curl) failed too. If apt cannot find a mirror,
# run termux-change-repo and pick a mirror group.
apt update
apt full-upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
# ffmpeg pushes the camera into the platform's media server (stream copy, no re-encoding).
apt install -y libc++ nodejs-lts curl tar procps ffmpeg
if ! node --version >/dev/null 2>&1 || ! curl --version >/dev/null 2>&1 || ! ffmpeg -version >/dev/null 2>&1; then
  echo "node, curl or ffmpeg does not start. Run: apt update && apt full-upgrade -y   then this script again."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then echo "Node $(node --version) is too old; need 22 or newer."; exit 1; fi
echo "Node $(node --version)"

echo "--- files into $EDGE"
mkdir -p "$EDGE/bin" "$EDGE/data" "$EDGE/logs"
cp "$KIT/edge-gateway.mjs" "$KIT/siyi-probe.mjs" "$KIT/mediamtx.android.yml" "$KIT/start.sh" "$KIT/stop.sh" "$KIT/status.sh" "$KIT/probe.sh" "$EDGE/"
cp "$KIT/site.remote.example.json" "$KIT/site.matek-ugv.example.json" "$EDGE/"
[ -f "$KIT/VERSION" ] && cp "$KIT/VERSION" "$EDGE/"
if [ -f "$EDGE/site.json" ]; then
  echo "keeping the existing $EDGE/site.json"
else
  cp "$KIT/site.remote.example.json" "$EDGE/site.json"
fi
chmod +x "$EDGE/start.sh" "$EDGE/stop.sh" "$EDGE/status.sh" "$EDGE/probe.sh"

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

echo "--- home-screen buttons (Termux:Widget app)"
# Each file in ~/.shortcuts is a button in the Termux:Widget home-screen widget. It opens a Termux
# window, runs the script and waits for Enter so the result stays readable.
SC="$HOME/.shortcuts"
mkdir -p "$SC"
rm -f "$SC"/*" Edge" "$SC"/*" ตรวจลิงก์รถ" 2>/dev/null || true
button() { # file name, command
  printf '#!/data/data/com.termux/files/usr/bin/bash\n%s\necho\nread -rp "Press Enter to close" _\n' "$2" >"$SC/$1"
  chmod 700 "$SC/$1"
}
button "1 เริ่ม Edge" "$EDGE/start.sh"
button "2 หยุด Edge" "$EDGE/stop.sh"
button "3 สถานะ Edge" "$EDGE/status.sh"
button "4 ตรวจลิงก์รถ" "$EDGE/probe.sh"
ls -1 "$SC"

echo
echo "Installed. Next (guide: README_TH.md):"
echo "  0. $EDGE/probe.sh                  read-only link check (vehicle on, gateway stopped)"
echo "     Matek H743-WING vehicle: cp $EDGE/site.matek-ugv.example.json $EDGE/site.json"
echo "  1. nano $EDGE/site.json            key (and geo)"
echo "  2. $EDGE/start.sh                  or the '1 เริ่ม Edge' button of the Termux:Widget widget"
