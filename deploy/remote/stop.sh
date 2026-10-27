#!/data/data/com.termux/files/usr/bin/bash
# Stops the edge gateway, its video push and MediaMTX on the UniRC 7 Pro (if start.sh was closed without Ctrl+C).
EDGE="$(cd "$(dirname "$0")" && pwd)"
pkill -f 'edge-gateway.mjs' && echo "gateway stopped" || echo "gateway was not running"
# The gateway stops its ffmpeg itself; this catches one left behind if the gateway was killed.
pkill -f 'ffmpeg .*-f rtsp' 2>/dev/null && echo "video push stopped" || true
if [ -f "$EDGE/data/mediamtx.pid" ]; then kill "$(cat "$EDGE/data/mediamtx.pid")" 2>/dev/null && echo "MediaMTX stopped"; rm -f "$EDGE/data/mediamtx.pid"; fi
pkill -f 'bin/mediamtx' 2>/dev/null || true
termux-wake-unlock 2>/dev/null || true
