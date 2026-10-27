#!/usr/bin/env bash
# Installs what the APK build needs into $HOME on Linux (WSL Ubuntu or a CI runner):
#   Android command-line tools, SDK platform + build tools, NDK, CMake, and a Gradle used once
#   to create the wrapper. Needs Java 17+ (apt install openjdk-21-jdk-headless) plus unzip/curl/make.
# Running it accepts the Android SDK License (the person running it must agree to it).
# Safe to run again: it skips what is already there.
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/android-sdk}"
CMDLINE_ZIPS=(commandlinetools-linux-13114758_latest.zip commandlinetools-linux-11076708_latest.zip)
PACKAGES=("platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018" "cmake;3.22.1")
GRADLE_VERSION=8.11.1

for tool in java unzip curl make; do
  command -v "$tool" >/dev/null || { echo "missing $tool (apt install openjdk-21-jdk-headless unzip curl make)"; exit 1; }
done

mkdir -p "$SDK/cmdline-tools"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  for z in "${CMDLINE_ZIPS[@]}"; do
    if curl -fsSL -o "$tmp/cmdline.zip" "https://dl.google.com/android/repository/$z"; then break; fi
  done
  unzip -q "$tmp/cmdline.zip" -d "$tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
fi
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

# `yes` dies of SIGPIPE when sdkmanager stops reading: not an error.
(yes || true) | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null || true
"$SDKMANAGER" --sdk_root="$SDK" "${PACKAGES[@]}" | grep -v '^\[=*' || true
for p in "${PACKAGES[@]}"; do
  [ -d "$SDK/${p//;//}" ] || { echo "sdkmanager did not install $p"; exit 1; }
done

if [ ! -x "$HOME/opt/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  mkdir -p "$HOME/opt"
  curl -fsSL -o "$HOME/opt/gradle.zip" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  unzip -q "$HOME/opt/gradle.zip" -d "$HOME/opt"
  rm "$HOME/opt/gradle.zip"
fi

cat <<EOF
toolchain ready
  ANDROID_HOME=$SDK
  NDK=$SDK/ndk/27.2.12479018
  gradle=$HOME/opt/gradle-$GRADLE_VERSION/bin/gradle
EOF
