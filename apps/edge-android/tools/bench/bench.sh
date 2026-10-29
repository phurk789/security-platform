#!/usr/bin/env bash
# Test bench for the edge app, in Linux / WSL Ubuntu (KVM needed for the emulator). From the emulator,
# 10.0.2.2 is this machine:
#   platform server (pilot)  :8099   the repository's dist build (npm run build -w @13store/server -w @13store/web)
#   "office" MediaMTX        :18554 RTSP ingest, :18889 WebRTC, auth through the server as on the office server
#   camera MediaMTX          :8554  rtsp://10.0.2.2:8554/main.264, an ffmpeg test pattern (apt install ffmpeg)
#   fake rover               udp :19856, stands in for the UniRC 7 Pro datalink
#   emulator "edge33"        Android 13 x86_64, headless
#
#   bench.sh setup   once: emulator + Android 13 image, Node 24, MediaMTX 1.9.3 into ~/opt
#   bench.sh up      start everything and wait for the emulator
#   bench.sh test    pair the app by QR link, Start, check LIVE + video, then screen off with Doze for 2 min
#   bench.sh update <newer.apk>   publish it (with its .json) and let the installed app update itself
#   bench.sh down    stop everything
# The bench admin password and media secret are generated into ~/e2e/secrets.env (mode 600), never printed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
BENCH="$HOME/e2e"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
ADB="$SDK/platform-tools/adb"
NODE="$HOME/opt/node-v24.15.0-linux-x64/bin/node"
MTX="$HOME/opt/mediamtx/mediamtx"
API=http://127.0.0.1:8099/api/v1
# The newest emulator-capable build unless APK is set.
APK="${APK:-$(ls -t "$REPO"/apps/edge-android/dist/13store-edge-*-arm64-v8a-x86_64.apk 2>/dev/null | head -1)}"
mkdir -p "$BENCH/logs" "$BENCH/data" "$BENCH/shots"
cd "$BENCH"

setup() {
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "emulator" "system-images;android-33;google_apis;x86_64" | grep -v '^\[=*' | tail -1
  "$SDK/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx edge33 ||
    echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n edge33 -k "system-images;android-33;google_apis;x86_64" -d pixel_c >/dev/null
  mkdir -p "$HOME/opt"
  [ -x "$NODE" ] || { curl -4 -fsSL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz | tar -xJ -C "$HOME/opt"; }
  [ -x "$MTX" ] || { mkdir -p "$HOME/opt/mediamtx" && curl -4 -fsSL https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz | tar -xz -C "$HOME/opt/mediamtx"; }
  command -v ffmpeg >/dev/null || echo "install ffmpeg for the test camera: sudo apt install ffmpeg"
}

secrets() {
  if [ ! -f secrets.env ]; then
    (umask 077; printf 'ADMIN_PASSWORD=%s\nMEDIA_SECRET=%s\n' "$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" >secrets.env)
  fi
  set -a; . ./secrets.env; set +a
}

bg() { # name, command...   (own session: Node ignores nohup, a hang-up would stop it)
  local name="$1"; shift
  if [ -f "$name.pid" ] && kill -0 "$(cat "$name.pid")" 2>/dev/null; then echo "$name: running"; return; fi
  setsid "$@" >"logs/$name.log" 2>&1 </dev/null &
  echo $! >"$name.pid"
  echo "$name: started"
}

up() {
  secrets
  cat >mtx-ingest.yml <<'EOF'
logLevel: info
rtspAddress: :18554
rtpAddress: :18000
rtcpAddress: :18001
rtspAuthMethods: [basic]
rtmp: no
hls: no
srt: no
webrtcAddress: :18889
webrtcLocalUDPAddress: :18189
webrtcLocalTCPAddress: :18189
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: [127.0.0.1]
authMethod: http
authHTTPAddress: http://127.0.0.1:8099/api/v1/media/auth
authHTTPExclude: [{ action: api }, { action: metrics }, { action: pprof }]
api: no
playback: no
paths:
  all_others:
EOF
  cat >mtx-cam.yml <<'EOF'
logLevel: warn
rtspAddress: :8554
rtpAddress: :8000
rtcpAddress: :8001
rtmp: no
hls: no
srt: no
webrtc: no
api: no
paths:
  all_others:
EOF
  bg server env ENV_MODE=pilot PORT=8099 HOST=0.0.0.0 DATA_DIR="$BENCH/data" HSTS=0 \
    MEDIA_INGEST_URL=rtsp://10.0.2.2:18554 MEDIA_PUBLIC_URL=http://127.0.0.1:18889 WEB_DIST="$REPO/apps/web/dist" \
    "$NODE" "$REPO/apps/server/dist/index.js"
  bg mtx-ingest "$MTX" "$BENCH/mtx-ingest.yml"
  bg mtx-cam "$MTX" "$BENCH/mtx-cam.yml"
  sleep 1
  bg camera bash -c 'while true; do ffmpeg -hide_banner -loglevel warning -re -f lavfi -i testsrc2=size=1280x720:rate=25 -c:v libx264 -preset ultrafast -tune zerolatency -g 25 -bf 0 -pix_fmt yuv420p -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/main.264; sleep 1; done'
  bg rover "$NODE" "$HERE/fake-rover.cjs" "$REPO/node_modules" 19856
  # An emulator stopped mid-snapshot leaves locks that make the next one exit ("snapshot operation pending").
  pgrep -f 'qemu-system.*edge33' >/dev/null || find "$HOME/.android/avd/edge33.avd" -maxdepth 1 -name '*.lock' -exec rm -rf {} + 2>/dev/null
  bg emulator "$SDK/emulator/emulator" -avd edge33 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -camera-back none -camera-front none -accel on
  "$ADB" wait-for-device
  for _ in $(seq 1 120); do [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 2; done
  echo "emulator: Android $("$ADB" shell getprop ro.build.version.release | tr -d '\r') ready; server: $(curl -fsS $API/health)"
}

tap() { # resource id in the app
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null
  "$ADB" shell input tap $("$ADB" shell cat /sdcard/ui.xml | python3 -c "
import re,sys
m=re.search(r'resource-id=\"com.store13.edge:id/$1\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', sys.stdin.read())
print((int(m[1])+int(m[3]))//2, (int(m[2])+int(m[4]))//2)")
}

test_() {
  secrets
  local token code
  token="$(curl -fsS -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" $API/auth/login | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  local auth=(-H "authorization: Bearer $token" -H 'content-type: application/json')
  age() { curl -sS "${auth[@]}" $API/devices/UGV-01 | python3 -c 'import json,sys,time; print(round(time.time()-json.load(sys.stdin)["lastSeen"]/1000,1))'; }
  curl -sS "${auth[@]}" -d '{"id":"UGV-01","kind":"ugv","model":"Bench rover (fake MAVLink)"}' $API/devices >/dev/null
  code="$(curl -fsS "${auth[@]}" -d '{"label":"Emulator bench","gatewayId":"edge-emu-01","devices":[{"type":"mavlink","deviceId":"UGV-01","kind":"ugv","profile":"ardupilot-rover","model":"Bench rover","link":{"mode":"client","host":"10.0.2.2","port":19856},"allowRemoteArm":false,"teleop":true,"stream":{"rtsp":"rtsp://10.0.2.2:8554/main.264","push":true}}]}' $API/admin/pairing-codes | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')"
  # A fresh install, as on a new remote: an earlier test may have left a newer version code (Android refuses a downgrade).
  "$ADB" uninstall com.store13.edge >/dev/null 2>&1 || true
  echo "installing $(basename "$APK"): $("$ADB" install -g "$APK" | tail -1)"
  "$ADB" shell am start -W -a android.intent.action.VIEW -d "'psedge://pair?server=http%3A%2F%2F10.0.2.2%3A8099&code=$code'" com.store13.edge >/dev/null
  sleep 6
  "$ADB" exec-out screencap -p >shots/paired.png
  tap mainButton # Start
  sleep 20
  "$ADB" exec-out screencap -p >shots/running.png
  echo "gateways: $(curl -fsS "${auth[@]}" $API/admin/gateways)"
  echo "UGV-01 last data $(age) s ago"
  echo "UGV-01 on the server: $(curl -sS "${auth[@]}" $API/devices/UGV-01 | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: d.get(k) for k in ("mode", "integration", "teleop")})')"
  grep -c "is publishing to path 'ugv-01'" logs/mtx-ingest.log | sed 's/^/video publish sessions so far: /'
  "$ADB" shell input keyevent KEYCODE_SLEEP
  "$ADB" shell dumpsys battery unplug
  "$ADB" shell dumpsys deviceidle force-idle >/dev/null
  for i in 1 2 3 4; do sleep 30; echo "screen off, Doze, t+$((i * 30)) s: UGV-01 last data $(age) s ago"; done
  "$ADB" shell dumpsys deviceidle unforce >/dev/null
  "$ADB" shell dumpsys battery reset
  "$ADB" shell input keyevent KEYCODE_WAKEUP
  echo "screenshot: $BENCH/shots/running.png"
}

tap_text() { # tap the first element whose text is exactly $1 (case ignored); fails if none
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  local xy
  xy="$("$ADB" shell cat /sdcard/ui.xml | python3 -c "
import html,re,sys
for n in re.findall(r'<node [^>]*>', sys.stdin.read()):
    t = re.search(r' text=\"([^\"]*)\"', n); b = re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', n)
    if t and b and html.unescape(t[1]).strip().lower() == sys.argv[1].lower():
        print((int(b[1]) + int(b[3])) // 2, (int(b[2]) + int(b[4])) // 2); break" "$1")"
  [ -n "$xy" ] && "$ADB" shell input tap $xy
}

vcode() { "$ADB" shell dumpsys package com.store13.edge | grep -m1 -o 'versionCode=[0-9]*' | tr -d '\r'; }

# Publish a newer build (its .json next to it) and let the installed app update itself, as on a remote.
update_() {
  secrets
  local new="$1" man="${1%.apk}.json" token q
  [ -f "$new" ] && [ -f "$man" ] || { echo "usage: bench.sh update <newer .apk> (its .json next to it)"; return 1; }
  token="$(curl -fsS -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" $API/auth/login | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  q="$(python3 -c 'import json,sys,urllib.parse; m=json.load(open(sys.argv[1])); print(urllib.parse.urlencode({k: m[k] for k in ("packageName","versionCode","versionName","sha256")}))' "$man")"
  echo "published: $(curl -sS -X PUT -H "authorization: Bearer $token" -H 'content-type: application/vnd.android.package-archive' --data-binary @"$new" "$API/admin/edge-app?$q")"
  local before; before="$(vcode)"
  "$ADB" root >/dev/null 2>&1; sleep 2; "$ADB" wait-for-device # to read the app's log at the end
  "$ADB" shell am start -n com.store13.edge/.MainActivity >/dev/null; sleep 3
  if "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && "$ADB" shell cat /sdcard/ui.xml | grep -q 'id/settingsButton'; then
    tap settingsButton; sleep 2 # 0.3.0 and later: settings open from the gear in the top bar
  else
    for _ in 1 2 3; do "$ADB" shell input swipe 1200 1500 1200 300 200; done # 0.2.0: settings at the bottom
    sleep 1
  fi
  tap checkUpdateButton; sleep 4
  "$ADB" exec-out screencap -p >shots/update-available.png
  tap installUpdateButton; sleep 3
  if tap_text "Allow from this source"; then # first time only: Settings → Install unknown apps
    echo "allowed 13STORE Edge to install apps"; sleep 1
    "$ADB" shell input keyevent KEYCODE_BACK; sleep 2
    tap installUpdateButton
  fi
  for _ in $(seq 1 60); do tap_text "Update" && { echo "confirmed on Android's install screen"; break; }; sleep 2; done
  for _ in $(seq 1 60); do [ "$(vcode)" != "$before" ] && break; sleep 2; done
  sleep 15
  echo "installed: $before → $(vcode)"
  echo "gateways: $(curl -fsS -H "authorization: Bearer $token" $API/admin/gateways)"
  "$ADB" shell am start -n com.store13.edge/.MainActivity >/dev/null; sleep 3
  "$ADB" exec-out screencap -p >shots/after-update.png
  "$ADB" shell cat /data/user/0/com.store13.edge/files/logs/gateway.log | grep -E '\[app\]' | tail -6 | tr -d '\r'
  echo "audit: $(curl -fsS -H "authorization: Bearer $token" "$API/audit?limit=30" | python3 -c 'import json,sys; print([(e["action"], e["object"]) for e in json.load(sys.stdin) if e["action"].startswith("edge.app")][:4])')"
}

down() {
  "$ADB" emu kill 2>/dev/null || true
  for n in camera rover mtx-cam mtx-ingest server emulator; do [ -f "$n.pid" ] && kill -- -"$(cat "$n.pid")" 2>/dev/null; rm -f "$n.pid"; done
  echo "bench stopped"
}

case "${1:-}" in
  setup) setup ;;
  up) up ;;
  test) test_ ;;
  update) update_ "${2:-}" ;;
  down) down ;;
  *) sed -n '2,15p' "$0" ;;
esac
