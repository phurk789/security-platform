# คู่มือแฟลช ArduPilot Rover ลง SIYI UniFC 6 Pico (บนโต๊ะ)

ใช้คู่กับ [README ของ probe](README.md) และ [`docs/HARDWARE_SIYI.md`](../../docs/HARDWARE_SIYI.md) §1 การเลือก firmware บันทึกไว้ใน D-34 ([Decision Register](../../../docs/PHASE0_DECISION_REGISTER.md))

## ทำไมต้องแฟลช

บอร์ดมาจากโรงงานเป็น **ArduCopter 4.6.3** (build ของ SIYI) ซึ่งเป็นโปรแกรมของโดรน รถตีนตะขาบต้องใช้ **ArduPilot Rover** ด้วยเหตุผลเหล่านี้:

| เรื่อง | Copter (ตอนนี้) | Rover (ที่ต้องการ) |
|---|---|---|
| การขับ | มีแต่ตัวผสมสัญญาณมอเตอร์ใบพัด ขับรถไม่ได้ (บอร์ดรายงาน `Frame: UNSUPPORTED`) | skid steering: output 1 = ตีนตะขาบซ้าย, output 3 = ตีนตะขาบขวา (`SERVO1_FUNCTION 73`, `SERVO3_FUNCTION 74`) |
| โหมด | STABILIZE, LOITER, LAND… | **MANUAL** (นักบินขับ), **HOLD** (หยุด), **AUTO** (วิ่งตาม route จากแพลตฟอร์ม) ซึ่งแพลตฟอร์มใช้สั่งงาน |
| เมื่อ link หลุด | RTL หรือ Land (คิดว่ากำลังบินอยู่) | **Hold** หยุดอยู่กับที่ (`FS_ACTION 2`) |
| จำกัดความแรง | — | `MOT_THR_MAX 40` จำกัดไว้ 40 % สำหรับการทดสอบช่วงแรก |
| แพลตฟอร์ม | gateway แปลง mode และคำสั่งผิด | ตรงกับ profile `ardupilot-rover` ของ gateway |
| ไฟล์ param ของเรา | ไม่มีอยู่ราว 20 ตัว | ใช้ได้ทั้งไฟล์ |

สรุปคือแฟลชเพื่อให้บอร์ดรู้ว่าตัวเองเป็นรถ ค่าความปลอดภัยของเราจึงจะมีผลจริง ได้แก่ หยุดเมื่อ link หลุด จำกัดความแรง และบูตขึ้นมาในโหมด HOLD ทั้งหมดนี้เป็นเงื่อนไขของ safety gate L1 ก่อนสั่งรถจริงจากหน้าจอ

**ทำไมเป็น 4.8.0-dev:** Rover รุ่น stable และ beta ยังไม่มี build สำหรับบอร์ดนี้ build ทางการมีแค่ใน `latest` ซึ่งเป็นรุ่นที่ยังพัฒนาอยู่ ใช้ได้สำหรับทดสอบบนโต๊ะ ส่วนงานโชว์จะใช้ Rover stable ที่ขอจาก SIYI

## สิ่งที่ต้องมี

- PC Windows ที่ลง Mission Planner รุ่นล่าสุด
- สาย USB-C ที่ส่งข้อมูลได้ (สายชาร์จอย่างเดียวใช้ไม่ได้)
- ไฟล์ `ardurover.apj` (ขั้นที่ 2)
- ไฟล์ [`deploy/vehicle/tracked-ugv-rover.param`](../../deploy/vehicle/tracked-ugv-rover.param)

## ความปลอดภัย

- แฟลชบนโต๊ะเท่านั้น **ถอดสาย output (PWM) ไป actuator, มอเตอร์และ ESC ออกทั้งหมด** air unit ต่อไว้ได้
- **อย่าถอด USB ระหว่างที่กำลังแฟลช**
- ใช้ไฟล์ **`.apj` เท่านั้น** ห้ามใช้ `ardurover_with_bl.hex` เพราะไฟล์นั้นเขียนทับ bootloader ด้วย ถ้าใช้ `.apj` bootloader จะไม่ถูกแตะ แฟลชพลาดเมื่อไหร่ก็แฟลชซ้ำได้เสมอ
- ถ้า Mission Planner ขึ้นว่า **board ID ไม่ตรง (mismatch) ให้หยุด** อย่ากดข้าม

## ขั้นที่ 1: สำรองค่าเดิม

1. เสียบ USB เปิด Mission Planner เลือก COM port ของบอร์ด แล้วกด **Connect**
2. Config → Full Parameter List → **Save** แล้วตั้งชื่อเช่น `unifc6pico-copter-factory-2026-10-22.param`
3. กด **Disconnect**

ไฟล์นี้ใช้ตอนต้องกลับไปเป็น Copter และเป็นหลักฐานว่าค่าจากโรงงานเป็นอย่างไร เก็บไว้นอก repo ได้

## ขั้นที่ 2: ดาวน์โหลด firmware

1. เปิด `https://firmware.ardupilot.org/Rover/latest/SIYI-UniFC-6-PICO/`
2. เช็กว่าชื่อโฟลเดอร์คือ **`SIYI-UniFC-6-PICO`** ตรงทุกตัวอักษร
3. ดาวน์โหลด **`ardurover.apj`**
4. จดวันที่ของไฟล์ที่หน้าเว็บแสดงไว้ เพราะ build `latest` เปลี่ยนทุกวัน

## ขั้นที่ 3: แฟลช

1. Mission Planner ต้องอยู่ในสถานะ **Disconnect** (ถ้า Connect อยู่ พอร์ตจะถูกใช้อยู่ แฟลชไม่ได้)
2. ไปที่ **Setup → Install Firmware**
3. **ไม่ต้องกดรูปรถ (Rover)** เพราะปุ่มนั้นดึงจาก stable ซึ่งไม่มีบอร์ดนี้ ให้กด **Load custom firmware** ที่มุมขวาล่างแทน
4. เลือกไฟล์ `ardurover.apj`
5. ถ้าโปรแกรมบอกให้ถอด USB แล้วเสียบใหม่ ให้ทำตาม
6. รอจนขึ้น **"Upload Done"** ใช้เวลาประมาณ 1–2 นาที แล้วบอร์ดจะรีบูตเอง

ถ้าค้างหรือไม่สำเร็จ ให้ถอด USB เสียบใหม่แล้วเริ่มขั้นที่ 3 อีกรอบ

## ขั้นที่ 4: เช็กว่าเป็น Rover แล้ว

1. กด **Connect**
2. ไปที่ Flight Data → แท็บ **Messages** ต้องเห็น:
   - `ArduRover V4.8.0-dev (xxxxxxxx)`
   - `SIYI-UniFC-6-PICO …`
3. จดรหัส `xxxxxxxx` ไว้ นี่คือเวอร์ชันที่แฟลชจริง probe จะบันทึกให้อีกทางหนึ่งด้วย

## ขั้นที่ 5: โหลดค่าของเรา

1. Config → Full Parameter List → **Load from file** → เลือก `platform/deploy/vehicle/tracked-ugv-rover.param`
2. Mission Planner จะแสดงรายการค่าที่จะเปลี่ยน ให้ตรวจแล้วกดยืนยัน จากนั้นกด **Write Params**
3. ถ้าโปรแกรมแจ้งว่ามี parameter บางตัวหาไม่เจอ ให้จดชื่อไว้ เพราะ 4.8-dev อาจเปลี่ยนชื่อบางตัว
4. **รีบูต:** ถอด USB แล้วเสียบใหม่
5. Connect อีกครั้งแล้ว **Load from file + Write Params ซ้ำอีกรอบ** เพราะบาง parameter จะโผล่มาก็ต่อเมื่อรีบูตหลังเปลี่ยนค่าที่เกี่ยวข้องแล้ว (เช่นหลังตั้ง `FRAME_CLASS`)
6. รีบูตอีกครั้ง

ค่าที่ไฟล์มาร์กไว้ว่า CONFIRM (ช่วง PWM ของ actuator, `FS_THR_VALUE`, `RC7_OPTION`) ยังเป็นค่าร่าง ต้องวัดจากรถจริงก่อน arm

## ขั้นที่ 6: Calibration ที่ทำบนโต๊ะได้

การเปลี่ยนชนิดยานจะล้าง calibration ทั้งหมด:

| Calibration | ทำเมื่อไหร่ | ที่ไหนใน Mission Planner |
|---|---|---|
| Accelerometer | **ทำได้เลย** วางบอร์ดตามที่โปรแกรมบอกทีละด้าน | Setup → Mandatory Hardware → Accel Calibration |
| Compass | หลังติดโมดูล GPS + compass แล้ว | Setup → Mandatory Hardware → Compass |
| Radio | หลังต่อ S.Bus จาก air unit เข้า RC IN แล้ว | Setup → Mandatory Hardware → Radio Calibration |

## ขั้นที่ 7: ตั้งรีโมตแล้ว Disconnect

1. ไฟล์ param ตั้ง `SERIAL1_BAUD = 115` แล้ว ให้เปลี่ยน **Datalink 1 baud บนรีโมตเป็น 115200** ให้ตรงกัน
2. กด **Disconnect** ใน Mission Planner (สาย USB เสียบค้างไว้ให้บอร์ดมีไฟ) ถ้าไม่ Disconnect heartbeat ของ Mission Planner จะวิ่งออก TELEM1 ไปถึง probe ด้วย

## ขั้นที่ 8: รัน probe

จากโฟลเดอร์ `platform/`:

```powershell
npx tsx tools/siyi-bench/probe.ts --duration 40
```

ผลที่ควรได้:

| ผล | ข้อ |
|---|---|
| PASS | Autopilot heartbeat, Autopilot is ArduPilot Rover, Disarmed, Boot mode is HOLD |
| WARN ที่คาดไว้ | GNSS fix (ยังไม่ติด GPS), Battery (ไฟ USB ไม่ใช่แบต), parameter บรรทัด CONFIRM |

จากนั้นจดเวอร์ชันจากรายงาน (`statusText`) ลง [checklist หมวด I](../../../docs/IMPLEMENTATION_CHECKLIST.md) ข้อ "Firmware บนโต๊ะ (D-34)"

## ถ้ามีปัญหา

| อาการ | สาเหตุที่น่าจะเป็น | ให้ทำ |
|---|---|---|
| Mission Planner ไม่เห็น COM port | สายชาร์จอย่างเดียว หรือ driver | เปลี่ยนสาย ลองพอร์ต USB อื่น |
| ขึ้น board ID mismatch | ไฟล์ไม่ใช่ของบอร์ดนี้ | หยุด เช็กชื่อโฟลเดอร์ในขั้นที่ 2 แล้วแจ้งทีม |
| Upload ค้าง | การเชื่อมต่อ USB หลุด | ถอดเสียบ USB แล้วแฟลชใหม่ |
| probe ขึ้น "none decode as MAVLink" | baud สองฝั่งไม่ตรงกัน (บอร์ด 115200 แต่รีโมตยัง 57600) | ตั้ง Datalink 1 บนรีโมตเป็น 115200 |
| probe ขึ้น "No data at all" | connection mode บนรีโมตไม่ใช่ UDP หรือสาย TELEM1 หลุด | ดู README ของ probe ตาราง "ถ้าไม่ได้ heartbeat" |
| ต้องการกลับเป็น Copter | — | แฟลช firmware ของ SIYI จากเว็บ SIYI แล้วโหลดไฟล์สำรองจากขั้นที่ 1 |
