#!/data/data/com.termux/files/usr/bin/bash
# What runs on the remote, and the last log lines. Read-only.
EDGE="$(cd "$(dirname "$0")" && pwd)"
cd "$EDGE"
[ -f VERSION ] && echo "kit: $(cat VERSION)"
echo "--- processes"
pgrep -af 'edge-gateway.mjs|bin/mediamtx' || echo "nothing running"
echo "--- platform server"
server="$(node -e "console.log(require('./site.json').serverUrl.replace(/^ws/, 'http'))")"
curl -fsS --max-time 5 "$server/api/v1/health" && echo || echo "$server does not answer"
echo "--- gateway log"
tail -n 8 logs/gateway.log 2>/dev/null || echo "(none)"
echo "--- MediaMTX log"
tail -n 8 logs/mediamtx.log 2>/dev/null || echo "(none)"
