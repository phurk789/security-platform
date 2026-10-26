# รัน edge บนรีโมต SIYI UniRC 7 Pro (แบบ A, สำหรับทดสอบ)

ย้าย gateway และ MediaMTX จากโน้ตบุ๊กไปรันบนรีโมตเอง (รีโมตเป็น Android ใช้ Termux) รีโมตจะต่อออกไปหา server เอง เหมือนแบบ DJI ไม่ต้องมีโน้ตบุ๊กคั่น

```
FC → air unit → วิทยุ SIYI → UniRC 7 Pro [Termux: gateway + MediaMTX] ──Wi-Fi ออฟฟิศ──► 192.168.20.13:8090
                                                                     └──WebRTC──► เบราว์เซอร์ใน Wi-Fi เดียวกัน
```

> **ทำหลังจากต่อผ่านโน้ตบุ๊กได้แล้ว** ([`deploy/edge/FIRST_CONNECTION_TH.md`](../edge/FIRST_CONNECTION_TH.md)) จะได้รู้ว่าถ้าไม่ผ่าน ปัญหาอยู่ที่การย้ายมารีโมต ไม่ใช่ที่รถ
> **ยังไม่เคยทดสอบบนรีโมตจริง** ข้อที่มี 🧪 คือสิ่งที่ยังไม่รู้ว่าจะผ่าน ถ้าไม่ผ่านให้กลับไปใช้โน้ตบุ๊ก (ข้อ 10)

กฎเดิมทุกข้อยังใช้: รถอยู่ `SHADOW` (ดูอย่างเดียว) และ **gateway ได้ทีละตัว** ห้ามเปิดของโน้ตบุ๊กกับของรีโมตพร้อมกัน

## 0. เตรียมชุดบนโน้ตบุ๊ก

```powershell
npm run kit:remote
```

ได้โฟลเดอร์ `deploy\remote\dist\edge-kit\` (gateway ไฟล์เดียว, สคริปต์, config, คู่มือนี้)
ก๊อปทั้งโฟลเดอร์ไปที่ **Download** ของรีโมต เช่น เสียบสาย USB แล้วลากไฟล์ (MTP) หรือส่งผ่าน Google Drive

## 1. ติดตั้ง Termux บนรีโมต 🧪

- โหลด Termux จาก **F-Droid** หรือ **GitHub releases** (`termux-app_..._arm64-v8a.apk`) **ไม่ใช้ตัวใน Play Store** เพราะเก่าและติดตั้งแพ็กเกจไม่ได้
- อนุญาตให้ติดตั้งแอปจากแหล่งนี้เมื่อรีโมตถาม
- Settings → Apps → Termux → Battery → **Unrestricted** ไม่อย่างนั้น Android อาจปิด Termux ตอนพักจอ

## 2. ต่อ Wi-Fi ออฟฟิศบนรีโมต 🧪

- ต่อ Wi-Fi ที่ไปถึง `192.168.20.13` ได้ (วงเดียวกับโน้ตบุ๊ก) วิทยุ SIYI ใช้งานต่อได้ตามปกติ
- จด **IP ของรีโมตฝั่ง Wi-Fi**: Settings → Wi-Fi → แตะชื่อเครือข่าย → IP address (ต่อไปเรียกว่า `REMOTE_IP`)
- ควรจอง IP นี้ไว้ที่ router (DHCP reservation) เพราะ IP นี้อยู่ใน config และในรายการแหล่งวิดีโอที่ server อนุญาต

## 3. ติดตั้งใน Termux

ต้องมีเน็ต: จะดาวน์โหลด Node.js และ MediaMTX v1.9.3 (18.5 MB จาก GitHub ทางการ ตรวจขนาดไฟล์ก่อนติดตั้ง)

```bash
termux-setup-storage                      # อนุญาตให้ Termux อ่าน Download
cp -r ~/storage/downloads/edge-kit ~/edge-kit
bash ~/edge-kit/install.sh
```

ไฟล์จะอยู่ใน `~/edge` (ไฟล์ที่อยู่ใน Download รันตรงๆ ไม่ได้ ต้องก๊อปเข้า Termux ก่อน)

## 4. แก้ config บนรีโมต

```bash
nano ~/edge/site.json
nano ~/edge/mediamtx.android.yml
```

| ไฟล์ | แก้ | ค่า |
|---|---|---|
| `site.json` | `key` | gateway key ตัวเดียวกับใน `site.json` ของโน้ตบุ๊ก |
| `site.json` | `geo` | ค่าเดียวกับโน้ตบุ๊ก (จุดอ้างอิงที่ตั้งจาก GPS ในคู่มือโน้ตบุ๊กขั้นที่ 6) |
| `site.json` | `stream.whep` | `http://REMOTE_IP:8889/ugv-01/whep` |
| `mediamtx.android.yml` | `webrtcAdditionalHosts` | `[REMOTE_IP]` |

ถ้าในคู่มือโน้ตบุ๊กเปลี่ยน path กล้องหรือชื่อรถไว้ ให้แก้ให้ตรงกันที่นี่ด้วย

## 5. อนุญาตแหล่งวิดีโอของรีโมต (ครั้งเดียวต่อ IP)

หน้าเว็บ (admin) → **แหล่งวิดีโอที่อนุญาต** → ใส่ `http://REMOTE_IP:8889` → `อนุญาต`
(หรือจากโน้ตบุ๊ก: `deploy\edge\Set-EdgeOrigin.ps1 -Origin http://REMOTE_IP:8889`)

รายการนี้เก็บได้หลายที่อยู่ ของโน้ตบุ๊กยังอยู่ สลับกลับไปใช้โน้ตบุ๊กได้โดยไม่ต้องตั้งใหม่

## 6. ปิดของโน้ตบุ๊ก

- กด Ctrl+C ในหน้าต่าง `Start-Edge.ps1` และปิดหน้าต่าง MediaMTX
- บนรีโมต: ปิดการเชื่อมต่อ datalink ใน UniGCS (UniGCS ส่ง heartbeat ของตัวเองด้วย ถ้าเปิดค้างจะมี ground station สองตัวบน link) จะเปิดดูวิดีโอใน UniGCS ได้ แต่อย่าใช้ความละเอียดเต็ม

## 7. เปิดบนรีโมต

```bash
~/edge/start.sh
```

- ต้องเห็น `platform server ... : OK`, `MediaMTX: running`, `connected to ws://192.168.20.13:8090` และ `registered 1 device(s)`
- เปิด Termux ค้างไว้ สคริปต์ล็อกไม่ให้เครื่องหลับ (`termux-wake-lock`) กด Ctrl+C เพื่อหยุดทั้งคู่
- ดูสถานะจากอีกหน้าต่าง Termux (ปัดจากซ้าย → New session): `~/edge/status.sh`

## 8. ตรวจบนหน้าจอ

ตรวจแบบเดียวกับขั้นที่ 10 ของคู่มือโน้ตบุ๊ก แล้วเพิ่มอีก 3 ข้อที่เป็นเรื่องของรีโมตโดยเฉพาะ:

| ตรวจ 🧪 | ผ่านเมื่อ |
|---|---|
| ภาพจากกล้อง | เบราว์เซอร์ในเครื่องอื่นบน Wi-Fi เดียวกันเห็นภาพสด |
| พักจอรีโมต 2 นาที | รถยังไม่ขึ้น STALE บนหน้าจอ (Android ไม่ปิด Termux) |
| รีโมตเปิดทุกอย่างพร้อมกัน 15 นาที | ไม่ร้อนจนเตือน, UniGCS และการบังคับด้วยมือยังลื่น |

## 9. อัปเดตชุดในภายหลัง

`npm run kit:remote` บนโน้ตบุ๊ก ก๊อปโฟลเดอร์ใหม่ไปทับใน Download แล้ว:

```bash
~/edge/stop.sh
rm -rf ~/edge-kit && cp -r ~/storage/downloads/edge-kit ~/edge-kit && bash ~/edge-kit/install.sh
```

`install.sh` เก็บ `site.json` เดิมไว้ ไม่เขียนทับ (ถ้า `mediamtx.android.yml` ถูกเขียนทับ ให้ใส่ `REMOTE_IP` ใหม่)

## 10. กลับไปใช้โน้ตบุ๊ก

```bash
~/edge/stop.sh
```

จากนั้นรัน `Start-Edge.ps1` บนโน้ตบุ๊กตามปกติ

## ถ้ามีปัญหา

| อาการ | ลองแก้ |
|---|---|
| `pkg` ติดตั้งไม่ได้ / หาแพ็กเกจไม่เจอ | Termux มาจาก Play Store: ลบแล้วลงจาก F-Droid หรือ GitHub |
| `This kit needs aarch64` | รีโมตไม่ใช่ ARM 64 บิต ใช้แบบนี้ไม่ได้ กลับไปใช้โน้ตบุ๊ก |
| MediaMTX ขึ้น `netlink ... permission denied` | ตรวจว่า `webrtcIPsFromInterfaces: no` และใส่ `REMOTE_IP` ใน `webrtcAdditionalHosts` แล้ว |
| MediaMTX หยุดทันทีด้วย error อื่น | ดู `~/edge/logs/mediamtx.log` แล้วรันแค่ gateway บนรีโมตก่อน (ดูภาพผ่านโน้ตบุ๊กไปพลาง) |
| gateway ไม่ได้ heartbeat จากรถ | datalink ใน UniGCS ต้องเป็น UDP; ปิด datalink ของ UniGCS; 🧪 ลองเปลี่ยน `link.host` ใน `site.json` จาก `192.168.144.20` เป็น `127.0.0.1` |
| รถหลุดเป็น STALE เมื่อพักจอ | Battery → Unrestricted, ไม่ปัด Termux ทิ้ง, ดูว่ามีแจ้งเตือน "wake lock held" ของ Termux |
| ภาพจอดำ | กล้องยังส่ง H.265: ตั้งเป็น H.264 ใน UniGCS |
| เครื่องอื่นไม่เห็นภาพ | อยู่ Wi-Fi เดียวกับรีโมต, ทำข้อ 5 แล้ว, gateway รีสตาร์ทหลังข้อ 5 |
| `Start-Edge.ps1` บนโน้ตบุ๊กกับรีโมตเปิดพร้อมกัน | ปิดตัวใดตัวหนึ่งทันที (gateway ได้ทีละตัว) |
