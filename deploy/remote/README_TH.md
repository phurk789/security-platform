# รัน edge บนรีโมต SIYI UniRC 7 Pro (แบบ A, สำหรับทดสอบ)

ย้าย gateway และ MediaMTX จากโน้ตบุ๊กไปรันบนรีโมตเอง (รีโมตเป็น Android ใช้ Termux) รีโมตจะต่อออกไปหา server เอง เหมือนแบบ DJI ไม่ต้องมีโน้ตบุ๊กคั่น

```
FC → air unit → วิทยุ SIYI → UniRC 7 Pro [Termux: gateway + MediaMTX] ──Wi-Fi ออฟฟิศ──► 192.168.20.13:8090
                                                                     └──WebRTC──► เบราว์เซอร์ใน Wi-Fi เดียวกัน
```

> **ทำหลังจากต่อผ่านโน้ตบุ๊กได้แล้ว** ([`deploy/edge/FIRST_CONNECTION_TH.md`](../edge/FIRST_CONNECTION_TH.md)) จะได้รู้ว่าถ้าไม่ผ่าน ปัญหาอยู่ที่การย้ายมารีโมต ไม่ใช่ที่รถ
> ถ้ามาทางรีโมตเลยโดยไม่มีโน้ตบุ๊ก ให้ใช้ `probe.sh` (ข้อ 3.5) แยกปัญหาฝั่งรถออกก่อนเปิด gateway
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

## 3.5 ตรวจลิงก์กับรถ (อ่านอย่างเดียว)

เปิดรถ (กล้องห้อยหัวลง) ใน UniGCS ตั้ง Datalink 1 = UDP และ baud ให้ตรงกับพอร์ตของบอร์ดที่ต่อกับ air unit แล้วปิด UniGCS (Settings → Apps → UniGCS → Force stop) จากนั้น:

> หลังเปลี่ยน Datalink 1 เป็น UDP แล้ว ถ้าจะใช้ UniGCS เองต้องตั้งการเชื่อมต่อใน UniGCS เป็น **UDPCL** ที่ `192.168.144.20` พอร์ต `19856` ด้วย ไม่อย่างนั้น UniGCS เห็นรถแต่ค้างที่ "parameter loading" (เจอ 27 ต.ค.)

```bash
~/edge/probe.sh
```

- ต้องได้ **Autopilot heartbeat PASS** และ **Disarmed PASS** ก่อนไปขั้นต่อไป
- รายงานอยู่ใน `~/edge/reports/` (มี firmware ที่บอร์ดแสดง)
- ถ้าขึ้น "No data at all" ให้ลอง `~/edge/probe.sh --host 127.0.0.1` ถ้าผ่าน ให้แก้ `link.host` ใน `site.json` เป็น `127.0.0.1` ด้วย
- probe ไม่เทียบไฟล์ param (ไฟล์ในโปรเจกต์ทำไว้สำหรับ UniFC 6 Pico) ถ้าจะเทียบ ใช้ `--params <ไฟล์>`

## 4. แก้ config บนรีโมต

รถ Matek H743-WING (ชุดทดสอบ 27 ต.ค.) ให้เริ่มจากไฟล์ตัวอย่างของคันนี้ก่อน:

```bash
cp ~/edge/site.matek-ugv.example.json ~/edge/site.json
```

แล้วแก้:

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
- บนรีโมต: **ปิด UniGCS** (Force stop) ระหว่างที่ gateway ทำงาน ทดสอบ 27 ต.ค. พบว่าเมื่อทั้งสองต่อประตู `19856` พร้อมกัน:
  - UniGCS ยังเห็นข้อมูลรถ แต่**คำสั่งจาก UniGCS (เช่นเปลี่ยนโหมด) ไปไม่ถึงบอร์ด** และไม่มีอะไรเตือน
  - ตอน UniGCS ต่อหรือโหลด parameter ใหม่ platform ขาดข้อมูลรถไปประมาณ 2 นาที
  - คนขับยังใช้คันโยกและสวิตช์บนรีโมตได้ตามปกติ (ไม่ผ่าน datalink)
  - ถ้าต้องใช้ UniGCS: หยุด gateway ก่อน (Ctrl+C) ใช้เสร็จแล้วปิด UniGCS แล้วค่อยรัน `start.sh` ใหม่

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
| ภาพจอดำ / เว็บขึ้น "เซิร์ฟเวอร์วิดีโอขัดข้อง (400)" | กล้องยังส่ง H.265 (`mediamtx.log` ขึ้น `track (H265)` และ `doesn't contain any supported codec`): ตั้ง main stream เป็น H.264 ในเมนูกล้องของ UniGCS ถ้าหาเมนูไม่เจอ สั่งผ่าน SDK ของกล้อง (คำสั่ง `0x21`) แล้วปิดเปิดรถ กล้องในโดม (รหัส 75…) ใช้ค่าใหม่หลังรีบูต |
| UniGCS ค้าง "parameter loading" | การเชื่อมต่อใน UniGCS ต้องเป็น UDPCL `192.168.144.20:19856` เมื่อ Datalink 1 = UDP และต้องไม่มี gateway รันอยู่ |
| UniGCS กดเปลี่ยนโหมดไม่ไป | gateway รันอยู่ด้วย: หยุด gateway หรือใช้สวิตช์โหมดบนตัวรีโมตแทน |
| แผงอุปกรณ์บนเว็บขึ้น STALE ทั้งที่รถส่งข้อมูล | ดูด้วยบัญชี admin: admin ไม่ได้รับข้อมูลสด ให้ดูด้วยบัญชีหัวหน้าเวรหรือผู้ควบคุม |
| เครื่องอื่นไม่เห็นภาพ | อยู่ Wi-Fi เดียวกับรีโมต, ทำข้อ 5 แล้ว, gateway รีสตาร์ทหลังข้อ 5 |
| `Start-Edge.ps1` บนโน้ตบุ๊กกับรีโมตเปิดพร้อมกัน | ปิดตัวใดตัวหนึ่งทันที (gateway ได้ทีละตัว) |
