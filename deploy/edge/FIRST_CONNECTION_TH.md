# ต่อรถจริงครั้งแรก (UGV-01, SIYI UniFC 6 Pico + UniRC 7 Pro)

คู่มือทีละขั้นสำหรับวันทดสอบ ใช้โน้ตบุ๊กเครื่องนี้เป็น edge PC และ server จริงที่ `http://192.168.20.13:8090`

**เป้าหมายรอบแรก: ดูอย่างเดียว (`SHADOW`)** เห็นรถบนแผนที่ ทิศทาง แบตเตอรี่ สถานะ และภาพจากกล้องบนรถ
ระบบจะไม่ยอมให้สั่งรถวิ่งหรือหมุนกล้องจากหน้าจอ ส่วนคำสั่งหยุดและพักใช้ได้เสมอ
การเลื่อนเป็น `LIVE_MANUAL` (สั่งรถได้) ต้องผ่านการทดสอบความปลอดภัยใน [`docs/HARDWARE_SIYI.md`](../../docs/HARDWARE_SIYI.md) ก่อน รวมถึงปุ่ม E-stop จริง

## เตรียมไว้แล้ว (26 ต.ค.)

| ส่วน | สถานะ |
|---|---|
| Server `.13:8090` | โหมด **pilot** ข้อมูลใหม่ (volume `thermal_pilot-data`) ไม่มีบัญชีเดโม ข้อมูลเดโมเก็บไว้ใน volume เดิม + ไฟล์สำรอง |
| บัญชีผู้ดูแล | `admin` รหัสผ่านสุ่ม พิมพ์ไว้ใน log ของ server **ครั้งเดียว** (ขั้นที่ 1) |
| Gateway key | สร้างแล้ว พิมพ์ไว้ใน log ครั้งเดียว (ขั้นที่ 1) |
| MediaMTX | `deploy/edge/bin/mediamtx.exe` v1.9.3 (SHA-256 `AF2CE0DCE3201E10C39DAE4E6D8E52C983D6940B1FA0FDD7F3D16C87AC764626`) |
| สคริปต์ | `Start-Edge.ps1` (เปิดวิดีโอ + gateway), `Set-EdgeOrigin.ps1` (อนุญาตแหล่งวิดีโอ) |
| ตัวอย่าง config | `site.ugv.example.json`, `mediamtx.windows.yml` (กล้อง A8 mini ที่ `192.168.144.25`, RTSP `main.264`) |
| ข้อมูลจากการทดสอบอุปกรณ์จริง | `ระบบVMS\SIYI_PROTOCOL_HANDOFF.md` (26 ต.ค.): IP ที่สงวนไว้, codec, ทิศ yaw, ช่อง S.Bus |

## 1. เก็บรหัสผ่าน admin และ gateway key (ทำคืนนี้)

ค่าทั้งสองอยู่ใน log ของ container เท่านั้น **ถ้า container ถูกสร้างใหม่ log จะหาย** และยังไม่มีเครื่องมือรีเซ็ตรหัสผ่าน admin
ห้ามรัน `docker compose up` / `down` บน .13 จนกว่าจะเก็บค่าแล้ว

บน .13 (Remote Desktop หรือ SSH):

```powershell
docker logs thermal-server-1 2>&1 | Select-String "admin password|gateway key"
```

เก็บทั้งสองค่าไว้ใน password manager

## 2. เตรียมผู้ใช้และอุปกรณ์บนหน้าเว็บ (ทำวันนี้หรือพรุ่งนี้เช้า)

เข้า `http://192.168.20.13:8090` ด้วย `admin` (บัญชีนี้จัดการผู้ใช้/อุปกรณ์ได้ แต่ดูเหตุ สั่งรถ และ**ดูวิดีโอไม่ได้** ตอนตรวจหน้าจอให้ใช้ผู้ใช้ที่สร้างในขั้นนี้)

1. **ผู้ใช้** → `เพิ่มผู้ใช้` อย่างน้อย 2 คน:
   - หัวหน้าเวร (supervisor): อนุมัติภารกิจ และเป็นคนเลื่อนโหมดรถในอนาคต
   - ผู้ควบคุมอุปกรณ์ (operator): คนที่ถือสิทธิ์ควบคุมรถ
2. **Edge Gateway และอุปกรณ์** → `ลงทะเบียน` อุปกรณ์ `UGV-01` ชนิด UGV
   - adapter จะอัปเดตได้เฉพาะอุปกรณ์ที่ลงทะเบียนแล้ว
   - อุปกรณ์จริงเริ่มในโหมด `SHADOW` เสมอ

## 3. เตรียมรถ (ฮาร์ดแวร์)

จากผลทดสอบบนโต๊ะ 22 ต.ค. ยังขาด 3 อย่าง:

- [ ] **ต่อโมดูล GPS** เข้า GPS1 ถ้าไม่มี รถจะไม่ขึ้นบนแผนที่ และต้องอยู่กลางแจ้งเห็นท้องฟ้า
- [ ] **Calibrate compass** (Mission Planner) ไม่อย่างนั้นทิศทางบนแผนที่จะผิด
- [ ] **แก้ radio failsafe** ที่ค้างอยู่ (ตรวจการ bind รีโมตและ RC IN)

กล้อง A8 mini (จากการทดสอบบนโต๊ะ 26 ต.ค.):

- [ ] **ตั้ง codec เป็น H.264 ใน UniGCS** (ตั้งค่า main/sub stream) ค่าปัจจุบันเป็น H.265 แม้ path จะชื่อ `main.264` เบราว์เซอร์ส่วนใหญ่เล่น H.265 ผ่าน WebRTC ไม่ได้ จะต่อได้แต่จอดำ
- [ ] **เปิดไฟกล้องตอนห้อยหัวลง** (ฐานอยู่บน) ถ้าเปิดไฟตอนตั้งบนฐาน กล้องจะเข้าใจว่าติดตั้งคว่ำ แล้ว yaw ไม่ตอบสนอง
- [ ] ⚠️ **ยังไม่ต่อสาย S.Bus เข้ากล้อง** จนกว่าจะย้ายช่องของกล้อง ค่าเริ่มต้นของกล้องใช้ช่อง 7 คุม pitch แต่**ช่อง 7 ของรถคือ arm/disarm** (`RC7_OPTION`)
- ระหว่างทดสอบอย่าเปิดวิดีโอใน UniGCS ที่ความละเอียดเต็มพร้อมกัน (ดึงภาพจากกล้องได้ไม่เกิน MediaMTX 1 + UniGCS 1)

ความปลอดภัยตลอดการทดสอบ:
- คนขับถือ UniRC 7 Pro ตลอด และ**รถต้อง disarm** (arm เฉพาะบนรีโมตเมื่อพร้อม ระบบไม่ arm ให้)
- ปุ่ม E-stop จริงอยู่ใกล้มือ พื้นที่ปิด ไม่มีคนอยู่ใกล้ตีนตะขาบ

## 4. ต่อโน้ตบุ๊กเข้ากับ UniRC 7 Pro

1. เสียบตัวแปลง **USB-LAN** แล้วต่อสายเข้า port **LAN** ของ UniRC 7 Pro
2. ตั้ง IP ของการ์ดนี้เป็น `192.168.144.100/24` ไม่ต้องใส่ gateway (PowerShell แบบ Administrator ดูชื่อการ์ดจาก `Get-NetAdapter`):

   ```powershell
   New-NetIPAddress -InterfaceAlias "Ethernet 2" -IPAddress 192.168.144.100 -PrefixLength 24
   ```

   **ห้ามใช้ `.50`** SIYI สงวนไว้ให้ตัวแปลง HDMI และห้ามใช้ `.11 .12 .20 .25 .26 .60`

3. Wi-Fi ของโน้ตบุ๊กยังต่อเครือข่ายออฟฟิศไว้เหมือนเดิม (ใช้คุยกับ server)
4. ใน UniGCS บนรีโมต: Datalink 1 = **UDP**, baud = ค่าเดียวกับ `SERIAL1_BAUD` ของบอร์ด (115200 ถ้าโหลดไฟล์ param ของเรา) และ**ปิด UniGCS ไม่ให้ต่อ datalink ค้าง**
5. ตรวจทีละชั้น: `ping 192.168.144.20` (รีโมต), `ping 192.168.144.11` (air unit, ~20 ms), `ping 192.168.144.25` (กล้อง)

## 5. ตรวจ link ด้วย probe (อ่านอย่างเดียว ส่งคำสั่งไม่ได้)

จากโฟลเดอร์ repo:

```powershell
npx tsx tools/siyi-bench/probe.ts --duration 30
```

ต้องได้อย่างน้อย: heartbeat **PASS**, disarmed **PASS**, GNSS fix **PASS (3D)**
ถ้าไม่ผ่าน ดูตาราง "ถ้าไม่ได้ heartbeat" ใน [`tools/siyi-bench/README.md`](../../tools/siyi-bench/README.md)

## 6. ตั้งจุดอ้างอิงแผนที่จากตำแหน่ง GPS ของรถ

1. เปิดไฟล์รายงานที่ probe เขียน (`siyi-bench-<เวลา>.json`) ดูช่อง `position.lat` และ `position.lon`
2. หน้าเว็บ (admin) → **พื้นที่และ GIS** → ใส่ lat, lon, rotation `0` → `บันทึกจุดอ้างอิง`
3. ใส่ค่าเดียวกันใน `site.json` ช่อง `geo` (ขั้นที่ 7) ทั้งสองที่ต้องตรงกัน

รถจะไปโผล่ที่มุมตะวันตกเฉียงเหนือของภาพไซต์ (ภาพอาคารยังเป็นของไซต์เดโม)

## 7. สร้าง `site.json`

```powershell
Copy-Item deploy\edge\site.ugv.example.json deploy\edge\site.json
notepad deploy\edge\site.json
```

แก้ 3 จุด (ไฟล์นี้ไม่เข้า git เพราะมี key):
- `key` → gateway key จากขั้นที่ 1
- `geo` → lat/lon จากขั้นที่ 6 และ `rotationDeg: 0`
- `stream.whep` → เปลี่ยน `LAPTOP_IP` เป็น IP ของโน้ตบุ๊กฝั่ง Wi-Fi ออฟฟิศ (`Start-Edge.ps1` จะแสดงรายการ IP ให้) **ห้ามใช้ 127.0.0.1/localhost** เพราะ server ไม่ยอมรับ

ถ้ากล้องไม่ใช่ที่ `192.168.144.25` หรือ path ไม่ใช่ `main.264` (ดูคู่มือรุ่นกล้อง) ให้แก้ทั้ง `stream.rtsp` และ `source` ใน `mediamtx.windows.yml`

## 8. อนุญาตแหล่งวิดีโอ (ครั้งเดียวต่อ IP)

หน้าเว็บ (admin) → **แหล่งวิดีโอที่อนุญาต** → ใส่ `http://LAPTOP_IP:8889` (วางลิงก์ `stream.whep` ทั้งเส้นก็ได้) → `อนุญาต`
ถ้าระบบขอรหัสผ่านซ้ำให้ใส่รหัส admin ถ้า IP ของโน้ตบุ๊กเปลี่ยน ให้เพิ่ม IP ใหม่และแก้ `site.json`

ทางสำรองจากโน้ตบุ๊ก (ผลเหมือนกัน):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\edge\Set-EdgeOrigin.ps1 -Origin http://LAPTOP_IP:8889
```

## 9. เปิด edge

```powershell
powershell -ExecutionPolicy Bypass -File deploy\edge\Start-Edge.ps1
```

- สคริปต์ตรวจก่อนว่า**ไม่มี server/gateway ชุดอื่นรันอยู่บนเครื่องนี้** (เช่นชุดทดสอบของ session SIYI ที่เปิดค้างไว้) ถ้ามีจะหยุดและบอกวิธีปิด เพราะ gateway สองตัวต่อรีโมตพร้อมกันไม่ได้
- จากนั้นตรวจ server, รีโมต, air unit, กล้อง แล้วเปิด MediaMTX (หน้าต่างย่อ) และ gateway (หน้าต่างนี้ กด Ctrl+C เพื่อหยุด)
- ต้องเห็น `connected to ws://192.168.20.13:8090` และ `registered 1 device(s)`
- ครั้งแรก Windows อาจถามเรื่อง firewall ของ `mediamtx.exe`:
  - ถ้าดูวิดีโอบนโน้ตบุ๊กเครื่องนี้อย่างเดียว ไม่ต้องอนุญาตก็ได้
  - ถ้าให้เครื่องอื่นดูด้วย อนุญาตเฉพาะเครือข่าย Private

## 10. ตรวจบนหน้าจอ (เข้าด้วย supervisor หรือ operator)

| ตรวจ | ผ่านเมื่อ |
|---|---|
| UGV-01 ขึ้นในรายการยาน | ป้าย `TESTING` และ `SHADOW` |
| ตำแหน่ง | อยู่ที่จุดอ้างอิง ขยับตามเมื่อเข็นรถ (ภายในความแม่นยำ GPS) |
| ทิศทาง | หมุนรถแล้วไอคอนหมุนทางเดียวกัน |
| แบตเตอรี่ / สัญญาณ | ตรงกับรีโมต |
| แท็บอุปกรณ์ | Flight controller, GNSS, radio, battery เปลี่ยนจาก pending เป็น OK |
| วิดีโอ | กดเลือก UGV-01 แล้วเห็นภาพสด (ถ้าภาพค้าง ป้ายจะไม่ขึ้น LIVE) |
| (ถ้าลองสร้างภารกิจ) คำสั่งเริ่ม | **ถูกปฏิเสธ** พร้อมบอกว่าอยู่ในโหมด SHADOW (การสร้างเหตุต้องมีผู้ใช้บทบาทเจ้าหน้าที่รับแจ้ง/dispatcher เพิ่ม) |
| ถอดสาย LAN | ขึ้น STALE ภายใน 5 วินาที แล้ว OFFLINE; เสียบคืนแล้วกลับมาเอง |

บันทึกผลแต่ละข้อ (ผ่าน/ไม่ผ่าน, เวอร์ชัน firmware ที่บอร์ดแสดง) ไว้เป็นหลักฐาน

## ถ้ามีปัญหา

| อาการ | ตรวจ |
|---|---|
| `Start-Edge.ps1` บอก server ไม่ตอบ | เครือข่ายจากโน้ตบุ๊กไป `192.168.20.13` (VPN/Wi-Fi ออฟฟิศ) |
| gateway ขึ้น 401 / key ไม่ถูก | `key` ใน `site.json` ตรงกับ log ขั้นที่ 1 |
| ไม่มี UGV-01 บนหน้าจอ | ลงทะเบียน `UGV-01` แล้ว (ขั้นที่ 2) และ `deviceId` ตรงกัน |
| รถไม่ขึ้นบนแผนที่ | GNSS fix (probe), `geo` ใน `site.json` ตรงกับจุดอ้างอิงบนหน้าเว็บ |
| ไม่มีภาพ | ขั้นที่ 8 ทำแล้วและรีสตาร์ท gateway; IP ใน `stream.whep` ถูก; `ping 192.168.144.25`; หน้าต่าง MediaMTX ไม่มี error; ดูภาพด้วยผู้ใช้ที่ไม่ใช่ admin |
| ต่อได้แต่จอดำ (MediaMTX ไม่ขึ้น error) | กล้องยังส่ง H.265: ตั้งเป็น H.264 ใน UniGCS (ขั้นที่ 3) |
| `Start-Edge.ps1` หยุดเพราะ "อีกชุดรันอยู่" | ชุดทดสอบจาก session SIYI (server `127.0.0.1:8080` และ gateway จากโฟลเดอร์ `ระบบVMS`) ยังเปิดอยู่ ปิดตามคำสั่งที่สคริปต์แสดง แล้วรันใหม่ |
| audit มี `gateway.stream_rejected` | origin ของ `stream.whep` ไม่อยู่ในรายการ (ขั้นที่ 8) |

## ขั้นต่อไป: ย้าย edge ไปรันบนรีโมต (แบบ A)

เมื่อทางโน้ตบุ๊กใช้ได้แล้ว ลองรัน gateway และ MediaMTX บน UniRC 7 Pro เองได้ตาม [`deploy/remote/README_TH.md`](../remote/README_TH.md) (ใช้ key, geo และรถตัวเดียวกัน; ห้ามเปิดสองที่พร้อมกัน)

## กลับไปเป็นเดโมบน .13

บน .13 (ไม่ต้องลบอะไร ข้อมูลจริงยังอยู่ใน `thermal_pilot-data`):

```powershell
cd C:\Server\thermal
Copy-Item .env.server .env.server.pilot
Copy-Item .env.server.demo .env.server
(Get-Content .env) -replace 'thermal_pilot-data', 'thermal_thermal-data' | Set-Content -Encoding ascii .env
docker compose up -d
```

สลับกลับเป็น pilot ด้วยวิธีเดียวกันในทางกลับ
