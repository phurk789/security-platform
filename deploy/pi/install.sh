#!/usr/bin/env bash
# Installs the edge gateway on a computer on the vehicle: a Raspberry Pi with Raspberry Pi OS (64-bit, Lite is
# enough), or another Debian/Ubuntu machine. Run once from the copied kit folder:   sudo bash install.sh
# Running it again updates the gateway and keeps the pairing (/etc/13store-edge/site.json) and its state.
# Guide: README_TH.md
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/13store-edge
CONF=/etc/13store-edge
UNIT=/etc/systemd/system/13store-edge.service
NEED_REBOOT=0

if [ "$(id -u)" != 0 ]; then echo "ต้องใช้ sudo:  sudo bash install.sh"; exit 1; fi
if ! command -v apt-get >/dev/null || ! command -v systemctl >/dev/null; then
  echo "ชุดนี้ใช้กับ Raspberry Pi OS / Debian / Ubuntu ที่มี apt และ systemd เท่านั้น"; exit 1
fi
for f in edge-gateway.mjs edge-tool.mjs 13store-edge 13store-edge.service; do
  [ -f "$KIT/$f" ] || { echo "ไม่พบ $f ในโฟลเดอร์ชุดติดตั้ง: คัดลอกมาทั้งโฟลเดอร์ (npm run kit:pi)"; exit 1; }
done
MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo "$(uname -m) Linux")"
echo "--- เครื่อง: $MODEL"

echo "--- แพ็กเกจ: Node.js (รัน gateway) และ ffmpeg (ส่งภาพกล้องขึ้นเซิร์ฟเวอร์ ไม่แปลงไฟล์)"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs ffmpeg ca-certificates
if ! node --version >/dev/null 2>&1; then echo "node ไม่ทำงาน"; exit 1; fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then echo "Node $(node --version) เก่าเกินไป ต้อง 18 ขึ้นไป (Raspberry Pi OS Bookworm หรือใหม่กว่า)"; exit 1; fi
echo "Node $(node --version), $(ffmpeg -hide_banner -version | head -n 1)"

echo "--- ผู้ใช้ระบบ 'edge' (รัน gateway, ใช้พอร์ต serial ได้, ไม่มีสิทธิ์ root)"
if ! id edge >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/13store-edge --no-create-home --shell /usr/sbin/nologin edge
fi
usermod -a -G dialout,video edge

echo "--- ไฟล์ใน $APP"
install -d -m 0755 "$APP"
install -m 0644 "$KIT/edge-gateway.mjs" "$KIT/edge-tool.mjs" "$APP/"
for f in VERSION README_TH.md site.pi-ugv.example.json; do
  if [ -f "$KIT/$f" ]; then install -m 0644 "$KIT/$f" "$APP/"; fi
done
install -m 0755 "$KIT/13store-edge" /usr/local/bin/13store-edge
# The pairing (gateway key inside): root writes it, the gateway reads it, nobody else.
install -d -m 0750 -o root -g edge "$CONF"
if [ -f "$CONF/site.json" ]; then chown root:edge "$CONF/site.json"; chmod 0640 "$CONF/site.json"; fi

echo "--- บริการ 13store-edge (เริ่มเองตอนเปิดเครื่อง หลังจับคู่แล้ว)"
install -m 0644 "$KIT/13store-edge.service" "$UNIT"
systemctl daemon-reload
systemctl enable 13store-edge >/dev/null

# GPIO 14/15 (pins 8 and 10) carry the flight controller's TELEM1 as /dev/ttyAMA0 on Pi 3, 4 and 5:
#  • Pi 3/4: that UART normally serves Bluetooth; disable-bt gives it back to the pins (Bluetooth is not used here).
#  • Pi 5: UART0 is off until dtparam=uart0=on (/dev/serial0 is the 3-pin debug header there, not the pins).
#  • The Linux console must not use the port, or the board receives boot messages and a login prompt. On a Pi 5 the
#    console sits on the 3-pin UART connector (/dev/ttyAMA10, serial0): taking it off frees that connector for TELEM1 too.
if grep -qi 'raspberry pi' <<<"$MODEL"; then
  echo "--- UART บนขา GPIO14/15 สำหรับ TELEM1"
  BOOT=/boot/firmware
  [ -f "$BOOT/config.txt" ] || BOOT=/boot
  if ! grep -q '^# 13store-edge UART' "$BOOT/config.txt"; then
    cat >>"$BOOT/config.txt" <<'EOF'

# 13store-edge UART: flight controller TELEM1 on GPIO 14/15 as /dev/ttyAMA0 (deploy/pi/README_TH.md)
[all]
enable_uart=1
[pi3]
dtoverlay=disable-bt
[pi02]
dtoverlay=disable-bt
[pi4]
dtoverlay=disable-bt
[pi5]
dtparam=uart0=on
[all]
EOF
    NEED_REBOOT=1
  fi
  if grep -Eq 'console=(serial0|ttyAMA0|ttyS0),[0-9]+' "$BOOT/cmdline.txt"; then
    cp "$BOOT/cmdline.txt" "$BOOT/cmdline.txt.before-13store-edge"
    sed -i -E 's/console=(serial0|ttyAMA0|ttyS0),[0-9]+ ?//g' "$BOOT/cmdline.txt"
    NEED_REBOOT=1
  fi
  # Bluetooth's modem service would wait for a UART that now belongs to the pins.
  systemctl disable --now hciuart >/dev/null 2>&1 || true
fi

if [ -f "$CONF/site.json" ]; then
  echo "--- จับคู่ไว้แล้ว: เริ่ม gateway ใหม่ด้วยไฟล์ชุดนี้"
  systemctl restart 13store-edge
fi

echo
echo "ติดตั้งเสร็จ ($(cut -d' ' -f1 "$APP/VERSION" 2>/dev/null || echo '?'))"
if [ "$NEED_REBOOT" = 1 ]; then
  echo "*** ต้องรีบูตหนึ่งครั้งเพื่อเปิด UART:  sudo reboot"
fi
echo "ขั้นต่อไป (README_TH.md):"
echo "  1. sudo 13store-edge siyi-lan        ตั้งพอร์ต LAN ของ Pi ให้อยู่วงเดียวกับกล่อง SIYI (กล้อง 192.168.144.25)"
echo "  2. หน้าเว็บ › แอดมิน › จับคู่รีโมต (Edge) › เลือก 'Raspberry Pi บนรถ' › สร้างรหัส"
echo "  3. sudo 13store-edge pair <ที่อยู่เซิร์ฟเวอร์> <รหัส 6 หลัก>"
echo "  4. 13store-edge status"
