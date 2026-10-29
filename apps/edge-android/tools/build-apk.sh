#!/usr/bin/env bash
# Builds the field APK on Linux (WSL Ubuntu or CI).
#   1. on the PC, in the repository:  npm run build:android -w @13store/gateway
#   2. here (once):                   tools/setup-toolchain.sh && tools/build-natives.sh arm64-v8a
#   3. here:                          tools/build-apk.sh                 → dist/13store-edge-<version>.apk
#      for the emulator as well:      tools/build-apk.sh arm64-v8a,x86_64   (needs build-natives.sh x86_64)
# Signing: the first run creates a field signing key in ~/.13store/ (outside the repository). Keep a copy
# of that folder: an update must be signed with the same key, or the remote refuses it (uninstall + pair again).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ABIS="${1:-arm64-v8a}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
GRADLE_VERSION=8.11.1
SIGN_DIR="$HOME/.13store"
export EDGE_SIGNING_PROPS="${EDGE_SIGNING_PROPS:-$SIGN_DIR/edge-signing.properties}"

cd "$HERE"
[ -f ../gateway/dist-android/edge-gateway.mjs ] || { echo "Build the gateway first, on the PC: npm run build:android -w @13store/gateway"; exit 1; }

if [ ! -f gradle/wrapper/gradle-wrapper.jar ]; then
  "$HOME/opt/gradle-$GRADLE_VERSION/bin/gradle" wrapper --gradle-version "$GRADLE_VERSION" --distribution-type bin -q
fi

if [ ! -f "$EDGE_SIGNING_PROPS" ]; then
  mkdir -p "$SIGN_DIR" && chmod 700 "$SIGN_DIR"
  pw="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  keytool -genkeypair -keystore "$SIGN_DIR/edge-release.jks" -alias edge -keyalg RSA -keysize 3072 -validity 10000 \
    -dname "CN=13STORE Edge, O=13STORE" -storepass "$pw" -keypass "$pw" >/dev/null
  umask 077
  printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=edge\nkeyPassword=%s\n' "$SIGN_DIR/edge-release.jks" "$pw" "$pw" >"$EDGE_SIGNING_PROPS"
  echo "created the field signing key in $SIGN_DIR: back it up"
fi

./gradlew --no-daemon -q -PedgeAbis="$ABIS" :app:testReleaseUnitTest :app:assembleRelease
version="$(grep -m1 'versionName' app/build.gradle.kts | sed -E 's/.*"(.*)".*/\1/')"
mkdir -p dist
suffix=""
[ "$ABIS" = "arm64-v8a" ] || suffix="-${ABIS//,/-}"
out="dist/13store-edge-$version$suffix.apk"
cp app/build/outputs/apk/release/app-release.apk "$out"
echo "APK: $HERE/$out ($(du -h "$out" | cut -f1))"
