#!/data/data/com.termux/files/usr/bin/bash
# Read-only link check on the remote: listens to the flight controller through this remote's
# datalink (192.168.144.20:19856) and writes a report. It never arms, changes mode, uploads a
# route or writes a parameter. Run it with the gateway stopped (./stop.sh).
#   ./probe.sh                    30 s, no parameter comparison
#   ./probe.sh --duration 60
#   ./probe.sh --host 127.0.0.1   if the datalink does not answer on its LAN address
EDGE="$(cd "$(dirname "$0")" && pwd)"
cd "$EDGE"
if pgrep -f 'edge-gateway.mjs' >/dev/null 2>&1; then echo "Stop the gateway first: ./stop.sh"; exit 1; fi
mkdir -p reports
extra=()
case " $* " in *" --params "*) ;; *) extra+=(--no-params) ;; esac
node siyi-probe.mjs "${extra[@]}" --out "reports/probe-$(date +%Y%m%d-%H%M%S).json" "$@"
