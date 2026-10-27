#!/data/data/com.termux/files/usr/bin/bash
# Starts MediaMTX (background) and the edge gateway (this window) on the UniRC 7 Pro.
# Ctrl+C stops the gateway and MediaMTX together. The vehicle stays in SHADOW (watch only)
# until a supervisor promotes it after the safety tests.
set -euo pipefail

EDGE="$(cd "$(dirname "$0")" && pwd)"
cd "$EDGE"

if pgrep -f 'edge-gateway.mjs' >/dev/null; then echo "The gateway is already running here. Stop it first: ./stop.sh"; exit 1; fi
if grep -q 'REPLACE' site.json; then echo "site.json still has the placeholder gateway key."; exit 1; fi
# Comment lines in the MediaMTX config mention REMOTE_IP too; only the settings count.
if grep -q 'REMOTE_IP' site.json || grep -v '^[[:space:]]*#' mediamtx.android.yml | grep -q 'REMOTE_IP'; then echo "Put this remote's Wi-Fi address in site.json (stream.whep) and mediamtx.android.yml (webrtcAdditionalHosts)."; exit 1; fi

echo "!!! Only one gateway may talk to this remote's datalink: stop the laptop's Start-Edge.ps1 first."

server="$(node -e "console.log(require('./site.json').serverUrl.replace(/^ws/, 'http'))")"
if curl -fsS --max-time 5 "$server/api/v1/health" >/dev/null; then echo "platform server $server : OK"
else echo "WARNING: platform server $server does not answer (Wi-Fi? same network as the server?)"; fi

termux-wake-lock 2>/dev/null || echo "WARNING: termux-wake-lock failed; keep Termux in front and the screen on"

./bin/mediamtx mediamtx.android.yml >>logs/mediamtx.log 2>&1 &
mtx=$!
echo "$mtx" >data/mediamtx.pid
cleanup() {
  kill "$mtx" 2>/dev/null || true
  rm -f data/mediamtx.pid
  termux-wake-unlock 2>/dev/null || true
  echo "stopped"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
sleep 2
if kill -0 "$mtx" 2>/dev/null; then echo "MediaMTX: running (logs/mediamtx.log)"
else echo "WARNING: MediaMTX stopped at start; last lines:"; tail -n 5 logs/mediamtx.log; fi

echo "--- edge gateway (Ctrl+C to stop)"
export GATEWAY_CONFIG="$EDGE/site.json"
export GATEWAY_DATA_DIR="$EDGE/data/gateway"
node edge-gateway.mjs 2>&1 | tee -a logs/gateway.log
