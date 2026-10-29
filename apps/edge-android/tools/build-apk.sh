#!/usr/bin/env bash
# Builds the field APK on Linux (WSL Ubuntu or CI).
#   1. on the PC, in the repository:  npm run build:android -w @13store/gateway
#   2. here (once):                   tools/setup-toolchain.sh && tools/build-natives.sh arm64-v8a
#   3. here:                          tools/build-apk.sh                 → dist/13store-edge-<version>.apk + .json
#      for the emulator as well:      tools/build-apk.sh arm64-v8a,x86_64   (needs build-natives.sh x86_64)
# Publish an update: Admin → "Edge app updates", choose the .apk and its .json (raise versionCode first).
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

# Test builds only: EDGE_VERSION_CODE / EDGE_VERSION_NAME override app/build.gradle.kts; EDGE_OUT_DIR the output folder.
props=(-PedgeAbis="$ABIS")
[ -z "${EDGE_VERSION_CODE:-}" ] || props+=(-PedgeVersionCode="$EDGE_VERSION_CODE")
[ -z "${EDGE_VERSION_NAME:-}" ] || props+=(-PedgeVersionName="$EDGE_VERSION_NAME")
./gradlew --no-daemon -q "${props[@]}" :app:testReleaseUnitTest :app:assembleRelease

apk=app/build/outputs/apk/release/app-release.apk
badging="$("$ANDROID_HOME/build-tools/35.0.0/aapt2" dump badging "$apk")"
badging="${badging%%$'\n'*}" # first line: package name, versionCode, versionName
package="$(sed -E "s/^package: name='([^']*)'.*/\1/" <<<"$badging")"
code="$(sed -E "s/.* versionCode='([^']*)'.*/\1/" <<<"$badging")"
version="$(sed -E "s/.* versionName='([^']*)'.*/\1/" <<<"$badging")"
[ "$package" = com.store13.edge ] || { echo "unexpected package in the APK: $package"; exit 1; }
outdir="${EDGE_OUT_DIR:-dist}"
mkdir -p "$outdir"
suffix=""
[ "$ABIS" = "arm64-v8a" ] || suffix="-${ABIS//,/-}"
out="$outdir/13store-edge-$version$suffix.apk"
cp "$apk" "$out"
# Build manifest for Admin → Edge app updates: upload it together with the APK.
printf '{\n  "packageName": "%s",\n  "versionCode": %s,\n  "versionName": "%s",\n  "sha256": "%s",\n  "size": %s,\n  "abis": "%s",\n  "builtAt": "%s"\n}\n' \
  "$package" "$code" "$version" "$(sha256sum "$out" | cut -d' ' -f1)" "$(stat -c %s "$out")" "$ABIS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${out%.apk}.json"
echo "APK: $HERE/$out ($(du -h "$out" | cut -f1)), version $version ($code)"
echo "manifest: $HERE/${out%.apk}.json"
