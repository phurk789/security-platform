#!/usr/bin/env bash
# Builds the programs the app runs, per Android ABI, into app/src/main/jniLibs/<abi>/:
#   libnode.so           Node.js 18 as a library (nodejs-mobile release, checked by SHA-256)
#   libnode_launcher.so  node's main() linked to it (native/node_launcher.cc)
#   libffmpeg.so         ffmpeg built from ffmpeg.org source: RTSP in, RTSP out, stream copy only.
#                        LGPL 2.1 or later (no --enable-gpl, no external libraries). The build fails otherwise.
#   libc++_shared.so     C++ runtime libnode.so needs (from the NDK)
# Executables are named lib*.so because Android only lets an app run files from its native
# library folder, and only lib*.so files are installed there.
# Usage: tools/build-natives.sh [arm64-v8a] [x86_64]     (default: arm64-v8a, the SIYI remote)
# Needs tools/setup-toolchain.sh first. Work files go to $NATIVE_WORK (default ~/edge-android-natives).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
NDK="${ANDROID_NDK_HOME:-$SDK/ndk/27.2.12479018}"
WORK="${NATIVE_WORK:-$HOME/edge-android-natives}"
API=26
ABIS=("$@")
[ ${#ABIS[@]} -gt 0 ] || ABIS=(arm64-v8a)

NODE_VERSION=18.20.4
NODE_ZIP="nodejs-mobile-v$NODE_VERSION-android.zip"
NODE_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v$NODE_VERSION/$NODE_ZIP"
NODE_SHA256=bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af
FFMPEG_VERSION=8.1.3
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
# Checked against ffmpeg-8.1.3.tar.xz.asc (FFmpeg release key FCF986EA15E6E293A5644F10B4322F04D67658D8).
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3

TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
[ -x "$TC/bin/clang" ] || { echo "NDK not found at $NDK: run tools/setup-toolchain.sh"; exit 1; }
mkdir -p "$WORK/dl"

fetch() { # url file sha256
  local url="$1" out="$WORK/dl/$2" want="$3"
  if [ ! -s "$out" ]; then
    curl -4 -fL --retry 3 --connect-timeout 30 -o "$out.part" "$url"
    mv "$out.part" "$out"
  fi
  local got
  got="$(sha256sum "$out" | cut -d' ' -f1)"
  if [ -n "$want" ] && [ "$got" != "$want" ]; then echo "SHA-256 mismatch for $2: got $got, want $want"; rm -f "$out"; exit 1; fi
  echo "$2 sha256 $got"
}

fetch "$NODE_URL" "$NODE_ZIP" "$NODE_SHA256"
fetch "$FFMPEG_URL" "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"

NODE_DIR="$WORK/nodejs-mobile-$NODE_VERSION"
if [ ! -d "$NODE_DIR" ]; then
  mkdir -p "$NODE_DIR"
  unzip -q "$WORK/dl/$NODE_ZIP" -d "$NODE_DIR"
fi
NODE_INCLUDE="$(dirname "$(find "$NODE_DIR" -name node.h -path '*include*' | head -1)")"
[ -f "$NODE_INCLUDE/node.h" ] || { echo "node.h not found in $NODE_ZIP"; exit 1; }

FF_SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
[ -d "$FF_SRC" ] || tar -xf "$WORK/dl/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK"

for ABI in "${ABIS[@]}"; do
  case "$ABI" in
    arm64-v8a) TRIPLE=aarch64-linux-android; ARCH=aarch64; CPU=armv8-a; ASM=() ;;
    x86_64) TRIPLE=x86_64-linux-android; ARCH=x86_64; CPU=x86-64; ASM=(--disable-x86asm) ;; # emulator tests only
    *) echo "unsupported ABI $ABI"; exit 1 ;;
  esac
  OUT="$HERE/app/src/main/jniLibs/$ABI"
  mkdir -p "$OUT"
  CC="$TC/bin/$TRIPLE$API-clang"
  # Android 15+ devices may use 16 KB memory pages: align everything for them.
  PAGE=(-Wl,-z,max-page-size=16384)

  libnode="$(find "$NODE_DIR" -path "*/$ABI/libnode.so" | head -1)"
  [ -f "$libnode" ] || { echo "no libnode.so for $ABI in $NODE_ZIP"; exit 1; }
  cp "$libnode" "$OUT/libnode.so"
  cp "$TC/sysroot/usr/lib/$TRIPLE/libc++_shared.so" "$OUT/libc++_shared.so"
  "$CC++" -O2 -fPIE -pie -std=c++17 "${PAGE[@]}" -I"$NODE_INCLUDE" "$HERE/native/node_launcher.cc" -L"$OUT" -lnode -o "$OUT/libnode_launcher.so"
  "$TC/bin/llvm-strip" "$OUT/libnode_launcher.so"

  B="$WORK/ffmpeg-build-$ABI"
  if [ ! -x "$B/ffmpeg" ]; then
    rm -rf "$B" && mkdir -p "$B" && cd "$B"
    "$FF_SRC/configure" \
      --target-os=android --arch="$ARCH" --cpu="$CPU" --enable-cross-compile \
      --cc="$CC" --cxx="$CC++" --ar="$TC/bin/llvm-ar" --nm="$TC/bin/llvm-nm" --ranlib="$TC/bin/llvm-ranlib" \
      --strip="$TC/bin/llvm-strip" --sysroot="$TC/sysroot" \
      --extra-ldflags="${PAGE[*]}" \
      --enable-pic --enable-static --disable-shared --disable-debug --disable-doc \
      --disable-autodetect --disable-everything --disable-avdevice \
      --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-network \
      --enable-protocol=tcp,udp,rtp \
      --enable-demuxer=rtsp,rtp,sdp \
      --enable-muxer=rtsp,rtp \
      --enable-parser=h264,hevc \
      --enable-decoder=h264,hevc \
      --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,extract_extradata \
      "${ASM[@]}" >"$B/configure.log" 2>&1 || { tail -30 "$B/configure.log"; exit 1; }
    grep -q '#define FFMPEG_LICENSE "LGPL version 2.1 or later"' config.h || { echo "ffmpeg build is not LGPL: refusing"; exit 1; }
    make -j"$(nproc)" >"$B/make.log" 2>&1 || { tail -30 "$B/make.log"; exit 1; }
  fi
  "$TC/bin/llvm-strip" -o "$OUT/libffmpeg.so" "$B/ffmpeg"
  echo "$ABI: $(cd "$OUT" && ls -l --block-size=K | awk 'NR>1 {print $9" "$5}' | tr '\n' ' ')"
done

# License texts shipped inside the APK (Settings → About in the app shows them).
LIC="$HERE/app/src/main/assets/licenses"
mkdir -p "$LIC"
cp "$FF_SRC/COPYING.LGPLv2.1" "$LIC/ffmpeg-LGPL-2.1.txt"
node_license="$(find "$NODE_DIR" -maxdepth 3 -iname 'LICENSE*' | head -1)"
if [ -n "$node_license" ]; then cp "$node_license" "$LIC/nodejs-LICENSE.txt"; else curl -4 -fsSL -o "$LIC/nodejs-LICENSE.txt" "https://raw.githubusercontent.com/nodejs-mobile/nodejs-mobile/v$NODE_VERSION/LICENSE"; fi
cp "$NDK/NOTICE" "$LIC/android-ndk-libcxx-NOTICE.txt" 2>/dev/null || true
echo "natives ready in $HERE/app/src/main/jniLibs"
