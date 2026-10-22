# SIYI bench probe (อ่านอย่างเดียว)

เครื่องมือทดสอบบนโต๊ะสำหรับ **UniFC 6 Pico + air unit + UniRC 7 Pro** ก่อนต่อกับ gateway ของแพลตฟอร์ม เป็นขั้นแรกของ milestone L1 ([Master Plan §22](../../../docs/SMART_DIGITAL_TWIN_MASTER_PLAN.md), [ADR-015](../../../docs/adr/ADR-015-thermalplatform-codebase-as-base.md))

## เครื่องมือนี้ทำอะไร

- ฟัง heartbeat, mode, สถานะ arm, แบตเตอรี่, GPS, ตำแหน่ง, RSSI และ STATUSTEXT จาก flight controller
- อ่าน parameter ทั้งหมด แล้วเทียบกับ [`deploy/vehicle/tracked-ugv-rover.param`](../../deploy/vehicle/tracked-ugv-rover.param)
- เขียนรายงาน JSON และแสดงผล PASS / WARN / FAIL บนหน้าจอ

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
  - ถ้ามี ground station อื่นอยู่บน link รายงานจะขึ้น WARN

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

4. ใน SIYI app ของรีโมต ตั้ง **datalink baud = 115200** ให้ตรงกับ `SERIALn_BAUD` ของ flight controller

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
| Autopilot heartbeat (FAIL) | สาย LAN, IP ของ PC, baud ใน SIYI app, `SERIALn_PROTOCOL=2` และ `SERIALn_BAUD=115` บน UART ที่ต่อกับ air unit, สายจาก air unit เข้า TELEM |
| Heartbeat rate / Link fresh | สัญญาณระหว่าง air unit กับรีโมต, เสาสัญญาณ |
| Autopilot is ArduPilot Rover | firmware ที่โหลดบน UniFC 6 Pico (ต้องเป็น Rover สำหรับรถตีนตะขาบ) |
| Disarmed on the bench (FAIL) | **disarm ทันทีบนรีโมต** |
| Boot mode is HOLD | `INITIAL_MODE=4` และตำแหน่งสวิตช์ mode บนรีโมต |
| Telemetry streams arriving | `SR1_POSITION`, `SR1_EXTRA1`, `SR1_EXT_STAT` (probe ไม่ส่งคำสั่งขอ stream เพราะเป็นแบบอ่านอย่างเดียว) |
| Battery voltage | power module และ `BATT_MONITOR` |
| GNSS fix | ต้องมีโมดูล GPS และเห็นท้องฟ้า — **จำเป็นสำหรับการโชว์ตำแหน่งบนแผนที่** |
| Parameters match | รายการที่ต่างพิมพ์ไว้ใต้ผลตรวจ บรรทัดที่ไฟล์ทำเครื่องหมาย CONFIRM ต้องวัดจากรถจริงก่อน |

แนบไฟล์รายงานลงใน checklist ([IMPLEMENTATION_CHECKLIST](../../../docs/IMPLEMENTATION_CHECKLIST.md) หมวด I) เป็นหลักฐานของ L1

## ขั้นต่อไป

เมื่อ probe ผ่าน (อย่างน้อยต้องได้ heartbeat และ disarmed) ให้รัน gateway ของแพลตฟอร์มด้วย [`apps/gateway/config/siyi-site.example.json`](../../apps/gateway/config/siyi-site.example.json) ตาม [`docs/HARDWARE_SIYI.md`](../../docs/HARDWARE_SIYI.md) §4 ในโหมด developer sandbox

รถจริงต้องอยู่ใน `SHADOW` จนกว่า safety gate ของ L1 จะผ่านครบ
