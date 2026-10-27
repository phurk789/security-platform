# Edge app for the SIYI remote (Android)

Runs the edge gateway (`apps/gateway`) on the SIYI UniRC 7 Pro without Termux: pair by code, Start/Stop,
status on screen, keeps running with the screen off. Field guide in Thai: [README_TH.md](README_TH.md).
This is CLEANUP_PLAN E-6 (app) on top of E-3 (pairing by code).

## How it works

```
MainActivity ── Pair ──► POST /api/v1/edge/pair (6-digit code) ──► gateway key + site config
     │                    key stored encrypted (Android Keystore AES-GCM) in noBackupFilesDir
     └─ Start ─► GatewayService (foreground service "connectedDevice", wake lock, Wi-Fi lock)
                    └─ libnode_launcher.so edge-gateway.mjs        (Node 18, nodejs-mobile)
                          env: GATEWAY_CONFIG, GATEWAY_KEY, FFMPEG_PATH=libffmpeg.so,
                               GATEWAY_STATUS_FILE, GATEWAY_EXIT_WITH_PARENT=1
                          └─ libffmpeg.so  camera RTSP ─copy─► platform MediaMTX (push)
```

- The gateway is the same code as everywhere else, bundled for Node 18
  (`npm run build:android -w @13store/gateway` → `apps/gateway/dist-android/edge-gateway.mjs`). nodejs-mobile's
  newest release is Node 18.20.4; the gateway uses nothing newer.
- Programs ship as `lib*.so` in `jniLibs/<abi>/` and are unpacked into the app's native library folder
  (`useLegacyPackaging = true`), the one place Android 10+ lets an app run programs from.
- `libnode_launcher.so` is node's own `main()` (`native/node_launcher.cc`) linked to nodejs-mobile's `libnode.so`,
  so the gateway runs as a child process: Stop sends SIGTERM, a crash does not take the app down, and the
  service starts it again (2 s doubling to 30 s). If the app process dies, the gateway notices its parent is
  gone and exits, so it never keeps the datalink.
- The gateway writes `files/gateway/status.json` every second (`GatewayStatus` in `apps/gateway/src/gateway.ts`):
  server link, key refused, per device accepted/refused and last telemetry (a MAVLink vehicle reports only
  while its heartbeat is fresh), video push state. The screen and the notification show it.
- Start on boot exists but is off by default: the gateway and UniGCS must not use the datalink together.

## ffmpeg licence

`tools/build-natives.sh` builds ffmpeg 8.1.3 from the official tarball (signature checked against the FFmpeg
release key, SHA-256 pinned) with `--disable-everything` plus only RTSP/RTP in and out, the H.264/H.265 parsers
and decoders (for stream probing) and the bitstream filters. No `--enable-gpl`, no external libraries; the script
stops unless `config.h` says "LGPL version 2.1 or later". ffmpeg is a separate program the app runs, not linked
into the app. The APK carries the licence texts and `assets/NOTICE.txt` (Settings → Licenses in the app).

## Build (Linux or WSL Ubuntu)

```bash
# once
sudo apt install openjdk-21-jdk-headless unzip curl make gcc
apps/edge-android/tools/setup-toolchain.sh           # Android SDK 35, NDK r27c, CMake, Gradle (accepts the SDK licence)
apps/edge-android/tools/build-natives.sh arm64-v8a   # libnode, launcher, LGPL ffmpeg (+ x86_64 for the emulator)

# each build: first on the PC (Windows) in the repository
npm run build:android -w @13store/gateway
# then in Linux
apps/edge-android/tools/build-apk.sh                 # → apps/edge-android/dist/13store-edge-<version>.apk
apps/edge-android/tools/build-apk.sh arm64-v8a,x86_64   # also runs in an x86_64 emulator
```

`build-apk.sh` runs the JVM unit tests (`app/src/test`) and signs with a field key it creates once in
`~/.13store/` (outside the repository). **Back that folder up**: an update signed with another key will not
install over the old app (uninstall, then pair again).

## Tested

On an Android 13 x86_64 emulator against a local pilot-mode server, MediaMTX with the same HTTP auth as the office
server, a fake ArduPilot rover on UDP and a test-pattern RTSP camera: pairing from the QR link, Start, vehicle
LIVE on the server, H.264 published to the media server, screen off with forced Doze, Stop, and restart after a
crash. Not yet on the real UniRC 7 Pro: the arm64 binaries are built the same way but have only run in that
emulator's x86_64 twin. See README_TH.md for the field test.
