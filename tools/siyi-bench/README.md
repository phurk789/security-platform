# SIYI bench probe (อ่านอย่างเดียว)

เครื่องมือทดสอบบนโต๊ะสำหรับ **UniFC 6 Pico + air unit + UniRC 7 Pro** ก่อนต่อกับ gateway ของแพลตฟอร์ม เป็นขั้นแรกของ milestone L1 ([Master Plan §22](../../../docs/SMART_DIGITAL_TWIN_MASTER_PLAN.md), [ADR-015](../../../docs/adr/ADR-015-thermalplatform-codebase-as-base.md))

## เครื่องมือนี้ทำอะไร

- ฟัง heartbeat, mode, สถานะ arm, แบตเตอรี่, GPS, ตำแหน่ง, RSSI และ STATUSTEXT จาก flight controller
- อ่าน parameter ทั้งหมด แล้วเทียบกับ [`deploy/vehicle/tracked-ugv-rover.param`](../../deploy/vehicle/tracked-ugv-rover.param)
- เขียนรายงาน JSON และแสดงผล PASS / WARN / FAIL บนหน้าจอ
- ถ้าไม่ได้ MAVLink จะบอกว่าเป็นเพราะไม่มีข้อมูลมาเลย หรือมีข้อมูลมาแต่ baud ไม่ตรงกัน

## สิ่งที่เครื่องมือนี้ทำไม่ได้ (บังคับในโค้ด)

[`guard.ts`](guard.ts) ยอมให้ส่งได้แค่ 3 ข้อความ: GCS `HEARTBEAT`, `PARAM_REQUEST_LIST` และ `PARAM_REQUEST_READ`

ข้อความอื่นทั้งหมดถูกปฏิเสธก่อนถึง socket จึงไม่มีทาง:
- arm หรือเปลี่ยน mode
- upload route
- override RC
- เขียน parameter

test ใน [`test/guard.test.ts`](test/guard.test.ts) ยืนยันกฎนี้

## ก่อนเริ่ม

- **ความปลอดภัย:**
  - ทดสอบบนโต๊ะโดยไม่ต่อ ESC, servo หรือ actuator
  - ถ้าบอร์ดติดกับรถแล้ว ให้ยกรางหรือล้อให้ลอยพ้นพื้น
- **นักบิน:** ถือ UniRC 7 Pro ไว้ และ**ไม่ arm** ระหว่างทดสอบ
- **โปรแกรมอื่นบน link:**
  - ปิด UniGCS บนรีโมต (หรืออย่าให้ต่อ datalink ค้างไว้) และปิด QGroundControl บน PC
  - ถ้าต่อ Mission Planner ผ่าน USB อยู่ ให้กด Disconnect ก่อน เพราะ ArduPilot ส่งต่อ heartbeat ของมันออก TELEM1 ด้วย
  - ถ้ามี ground station อื่นอยู่บน link รายงานจะขึ้น WARN
- **Firmware:** UniFC 6 Pico มาจากโรงงานเป็น **ArduCopter** (เครื่องของเราเป็น 4.6.3 เป็น build ของ SIYI) probe อ่านได้ทุก firmware แต่ข้อ Rover จะขึ้น WARN ก่อนใช้กับรถต้องแฟลช **ArduPilot Rover** แล้วโหลดไฟล์ param (D-34):
  - **บนโต๊ะ:** `ArduRover V4.8.0-dev` จาก `firmware.ardupilot.org/Rover/latest/SIYI-UniFC-6-PICO/` เพราะ Rover stable และ beta ยังไม่มีบอร์ดนี้ เป็น build ที่ยังพัฒนาอยู่และเปลี่ยนทุกวัน ให้บันทึกเวอร์ชันจากรายงาน probe (`statusText`) ทุกครั้งที่แฟลช
  - **งานโชว์:** Rover stable ที่ขอจาก SIYI
  - วิธีแฟลชอยู่ใน [`docs/HARDWARE_SIYI.md`](../../docs/HARDWARE_SIYI.md) §1 ต้องใช้ Load custom firmware เพราะปุ่ม Rover ปกติของ Mission Planner หาบอร์ดนี้ไม่เจอ
- **สาย:** UART 1 ของ air unit (GH1.25 3 ขา) → TELEM1 ของ Pico (6 ขา) ต้องใช้สายแปลง ไขว้ TX↔RX ต่อ GND และ**ไม่ต่อ 5V** เพราะ air unit มีไฟจาก XT30 ของตัวเอง ดูตารางสายเต็มใน [`docs/HARDWARE_SIYI.md`](../../docs/HARDWARE_SIYI.md) §1
- **ไฟ:** ทดสอบบนโต๊ะ ใช้ไฟ USB จาก PC เลี้ยงบอร์ดได้ แรงดันแบตที่ probe รายงานจะไม่ใช่ค่าจริงจนกว่าจะต่อ power module

## 1. ต่อ PC เข้ากับ UniRC 7 Pro

1. เสียบสาย LAN จาก PC เข้า port **LAN** ของ UniRC 7 Pro
2. ตั้ง IP แบบ static บนการ์ด LAN ของ PC เป็น `192.168.144.50`, mask `255.255.255.0` และไม่ต้องใส่ gateway
   - ห้ามใช้ `.11`, `.12`, `.20` หรือ `.25` เพราะ link ใช้อยู่แล้ว
   - บน Windows ใช้ PowerShell แบบ Administrator (เปลี่ยน `Ethernet` เป็นชื่อการ์ดจริงจาก `Get-NetAdapter`):

```powershell
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.144.50 -PrefixLength 24
```

3. ตรวจว่าเห็นรีโมต:

```powershell
ping 192.168.144.20
```

4. ตรวจว่า air unit ขึ้น link แล้ว: `ping 192.168.144.11` ต้องตอบ (ประมาณ 20 ms เพราะผ่านวิทยุ)
5. ใน UniGCS บนรีโมต เข้าเมนู datalink แล้วตั้ง Datalink 1:
   - **connection mode = UDP** ถ้าเป็นโหมด UART ข้อมูลจะเข้าแอปบนรีโมตเท่านั้น ไม่ออก LAN ส่วนโหมด UDP จะเปิด server ที่ `192.168.144.20:19856`
   - **baud = ค่าเดียวกับ `SERIAL1_BAUD` ของบอร์ด** ค่าจากโรงงานคือ 57600 ถ้าโหลดไฟล์ param ของเราแล้วจะเป็น 115200 ต้องเปลี่ยนสองฝั่งพร้อมกันเสมอ

## 2. รัน probe

จากโฟลเดอร์ `platform/` (ต้อง `npm ci` ไว้แล้ว):

```powershell
npx tsx tools/siyi-bench/probe.ts
```

ตัวเลือก:

| ตัวเลือก | ความหมาย | ค่าเริ่มต้น |
|---|---|---|
| `--host`, `--port` | datalink server ของ UniRC | `192.168.144.20`, `19856` |
| `--listen <port>` | รอให้ flight controller ส่ง UDP มาที่ PC (กรณีต่อ Ethernet ของ FC ตรง) | — |
| `--duration <วินาที>` | ระยะเวลาฟัง | `30` |
| `--params <ไฟล์>` | ไฟล์ค่า parameter ที่ใช้เทียบ | `deploy/vehicle/tracked-ugv-rover.param` |
| `--no-params` | ไม่อ่าน parameter | — |
| `--out <ไฟล์>` | ชื่อไฟล์รายงาน | `siyi-bench-<เวลา>.json` |

กด Ctrl+C เพื่อจบก่อนเวลาได้ รายงานจะถูกเขียนทุกครั้ง exit code เป็น 1 ถ้ามีข้อใด FAIL

## 3. อ่านผล

| Check | ถ้าไม่ผ่าน ให้ตรวจ |
|---|---|
| Autopilot heartbeat (FAIL) | อ่านรายละเอียดของข้อนี้ probe จะบอกว่าเป็นกรณีไหน (ดูตารางถัดไป) |
| Heartbeat rate / Link fresh | สัญญาณระหว่าง air unit กับรีโมต, เสาสัญญาณ |
| Autopilot is ArduPilot Rover | firmware ที่โหลดบน UniFC 6 Pico บอร์ดมาจากโรงงานเป็น ArduCopter ต้องแฟลช Rover สำหรับรถตีนตะขาบ |
| Disarmed on the bench (FAIL) | **disarm ทันทีบนรีโมต** |
| Boot mode is HOLD | `INITIAL_MODE=4` และตำแหน่งสวิตช์ mode บนรีโมต |
| Telemetry streams arriving | `SR1_POSITION`, `SR1_EXTRA1`, `SR1_EXT_STAT` (probe ไม่ส่งคำสั่งขอ stream เพราะเป็นแบบอ่านอย่างเดียว) |
| Battery voltage | power module และ `BATT_MONITOR` |
| GNSS fix | ต้องมีโมดูล GPS และเห็นท้องฟ้า — **จำเป็นสำหรับการโชว์ตำแหน่งบนแผนที่** |
| Parameters match | รายการที่ต่างพิมพ์ไว้ใต้ผลตรวจ บรรทัดที่ไฟล์ทำเครื่องหมาย CONFIRM ต้องวัดจากรถจริงก่อน |

### ถ้าไม่ได้ heartbeat

probe เก็บไบต์ดิบที่ได้จาก UDP ไว้ด้วย (ช่อง `rawLink` ในรายงาน) จึงแยกสาเหตุได้:

| รายละเอียดของข้อ heartbeat | หมายความว่า | ให้แก้ |
|---|---|---|
| No data at all | ไม่มีอะไรมาถึง PC เลย | connection mode ต้องเป็น UDP, ping `.11` ต้องตอบ, สาย UART เข้า TELEM1, บอร์ดมีไฟ |
| … read at twice its baud rate | มีไบต์มา แต่รีโมตอ่านเร็วกว่าบอร์ด 2 เท่า (เช่นรีโมต 115200 บอร์ด 57600) | ตั้ง baud สองฝั่งให้เท่ากัน |
| … none decode as MAVLink | มีไบต์มาแต่ถอดไม่ได้ | baud สองฝั่งไม่ตรงกันแบบอื่น หรือ `SERIAL1_PROTOCOL` ไม่ใช่ 2 |
| MAVLink arrives … but no autopilot heartbeat | มีแต่ ground station หรืออุปกรณ์อื่นบน link | ตรวจว่าอุปกรณ์ที่ต่อ UART ของ air unit คือ flight controller |

แนบไฟล์รายงานลงใน checklist ([IMPLEMENTATION_CHECKLIST](../../../docs/IMPLEMENTATION_CHECKLIST.md) หมวด I) เป็นหลักฐานของ L1

## ขั้นต่อไป

เมื่อ probe ผ่าน (อย่างน้อยต้องได้ heartbeat และ disarmed) ให้รัน gateway ของแพลตฟอร์มด้วย [`apps/gateway/config/siyi-site.example.json`](../../apps/gateway/config/siyi-site.example.json) ตาม [`docs/HARDWARE_SIYI.md`](../../docs/HARDWARE_SIYI.md) §4 ในโหมด developer sandbox

รถจริงต้องอยู่ใน `SHADOW` จนกว่า safety gate ของ L1 จะผ่านครบ
