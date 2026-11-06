# กล่อง AI บน Jetson (Orin Nano / Orin NX)

ให้ Jetson เป็น "กล่อง AI" ของไซต์ ต่อสาย LAN วงเดียวกับเครื่อง server แล้วลงทะเบียนครั้งเดียวด้วยคีย์ gateway
หลังจากนั้นคนในศูนย์ควบคุมกดสวิตช์ **AI** บนกล้องของรถคันไหน กล่องก็วิเคราะห์ภาพคันนั้นให้ ใช้ในอาคารได้เพราะไม่ต้องใช้ GPS

- ไม่ต้องลงทะเบียนอุปกรณ์ AI แยกต่อคัน และไม่ต้องแก้ไฟล์ตั้งค่าบน Jetson เมื่อมีรถใหม่
- บนรถไม่ต้องแก้อะไร ขอแค่รถส่งภาพขึ้นเซิร์ฟเวอร์วิดีโออยู่แล้ว

```
กล้องรถ ─(SIYI)─> รีโมต/Pi ──ส่งภาพ──> เครื่อง server (ระบบ + เซิร์ฟเวอร์วิดีโอ)
                                          │    ▲
           งาน: "วิเคราะห์ UGV-01" + สิทธิ์อ่านภาพ │    │ กรอบสด + เหตุ (ในนามรถคันนั้น)
                                          ▼    │
                        Jetson: gateway โหมดกล่อง AI ⇄ บริการ AI 127.0.0.1:8601 (GPU)
```

- **สวิตช์ AI** อยู่ที่ห้องบังคับ และที่ อุปกรณ์ › แท็บกล้อง
  - เปิด: เซิร์ฟเวอร์เลือกกล่อง AI ที่ยังว่าง แล้วให้สิทธิ์อ่านภาพรถคันนั้นคันเดียว ใช้ได้เฉพาะตอนที่กล่องยังมีงานนี้อยู่
  - ปิด: หยุดทันที
- **เปิดค้างได้:** เปิดไว้แล้วอยู่ต่อแม้เซิร์ฟเวอร์หรือ Jetson รีสตาร์ท จนกว่าจะมีคนกดปิด ถ้ากล่อง AI หลุด งานจะย้ายไปกล่องอื่นที่ยังว่าง หรือรอจนกล่องกลับมา
- **ใครกดได้:** ผู้สั่งการ ผู้ควบคุม หัวหน้า และผู้ดูแล (สิทธิ์ควบคุมกล้อง) ทุกครั้งที่กดจะบันทึกไว้ว่าใครเปิดหรือปิด
- **บริการ AI** (`vision_server.py`) รับภาพ JPEG แล้วตอบกรอบกลับ ส่วนโซน การติดตามคน และการเปิดเหตุ อยู่ที่ gateway กับระบบ

## สิ่งที่ต้องมี

- Jetson Orin Nano หรือ Orin NX ลง **JetPack 6** (Ubuntu 22.04) ต่อ LAN วงเดียวกับเครื่อง server และเข้า SSH ได้
- เครื่อง server ที่ตั้งเซิร์ฟเวอร์วิดีโอแล้ว (`MEDIA_INGEST_URL`, `MEDIA_PUBLIC_URL`) และรถที่ส่งภาพขึ้นเซิร์ฟเวอร์อยู่แล้ว
- บัญชีแอดมินของระบบ

## 1. หน้าแอดมิน (ครั้งเดียว)

**คีย์ API › สร้างคีย์ประเภท gateway** ชื่อ "Jetson AI" แล้วเก็บคีย์ไว้ (แสดงครั้งเดียว) ไม่ต้องลงทะเบียนอุปกรณ์ใดๆ

## 2. สิทธิ์บน Jetson (ครั้งเดียว ใช้ sudo)

```bash
sudo usermod -aG docker $USER        # ใช้ Docker ได้โดยไม่ต้อง sudo
sudo loginctl enable-linger $USER    # gateway ทำงานต่อแม้ไม่มีใครล็อกอิน และเริ่มเองตอนเปิดเครื่อง
```

ออกจาก SSH แล้วเข้าใหม่ ให้สิทธิ์กลุ่ม docker มีผล

**โหมดพลังงาน:** Orin NX 16 GB ที่ 15W วิเคราะห์ได้ราว 60 มิลลิวินาทีต่อภาพ พอสำหรับรถ 2 คัน คันละ 8 ภาพต่อวินาที
ถ้าต้องการรับรถมากขึ้น ให้ใช้ `sudo nvpmodel -m 0` (เต็มกำลัง กินไฟและร้อนขึ้น) แล้วเพิ่ม `capacity` ในขั้นที่ 4

## 3. บริการ AI (GPU)

```bash
mkdir -p ~/13store/vision/.config && cd ~/13store/vision
# คัดลอก deploy/jetson/vision_server.py จากโปรเจกต์มาไว้ที่นี่
curl -fsSLO https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8s.pt      # 22.6 MB

# ชุดรัน YOLO บน GPU ของ Jetson (ราว 7.7 GB) แล้วล็อกเวอร์ชันไว้ วันงานจะได้ไม่เปลี่ยนเอง
docker pull ultralytics/ultralytics:latest-jetson-jetpack6
docker inspect --format '{{index .RepoDigests 0}}' ultralytics/ultralytics:latest-jetson-jetpack6
docker tag ultralytics/ultralytics@sha256:<digest จากบรรทัดบน> 13store/ultralytics:jp6
```

สร้างโมเดล TensorRT บนเครื่องนี้ ใช้เวลาประมาณ 10 นาที:
- ตัดเน็ตด้วย `--network none` จะได้ไม่โหลดอะไรเพิ่มหรือส่งข้อมูลการใช้งานออกไป
- engine ผูกกับ GPU ของเครื่องนี้ ย้ายไปเครื่องอื่นไม่ได้

```bash
docker run --rm --name 13store-export --runtime nvidia --ipc=host --network none \
  -v $HOME/13store/vision:/work -w /work \
  -e YOLO_OFFLINE=true -e YOLO_AUTOINSTALL=false -e YOLO_CONFIG_DIR=/work/.config \
  13store/ultralytics:jp6 sh -c "yolo settings sync=False; yolo export model=/work/yolov8s.pt format=engine half=True imgsz=640 device=0"
```

ถ้าขึ้น `TensorRT: export success` แล้วตามด้วย `free(): invalid next size` แล้วค้าง ใช้ได้ปกติ ไฟล์ `yolov8s.engine` ถูกบันทึกไว้ก่อนแล้ว
ให้กด Ctrl-C แล้วสั่ง `docker rm -f 13store-export`

รันบริการ ให้เริ่มเองทุกครั้งที่เปิดเครื่อง แล้วลองกับรูปตัวอย่างที่มีคน:

```bash
docker run -d --name 13store-vision --restart unless-stopped --log-opt max-size=10m --log-opt max-file=3 --runtime nvidia --ipc=host \
  -p 127.0.0.1:8601:8601 -v $HOME/13store/vision:/work -w /work \
  -e YOLO_OFFLINE=true -e YOLO_AUTOINSTALL=false -e YOLO_CONFIG_DIR=/work/.config \
  13store/ultralytics:jp6 python3 vision_server.py --host 0.0.0.0 --model /work/yolov8s.engine

curl http://127.0.0.1:8601/health      # {"ok": true, "model": "yolov8s.engine"}
docker cp 13store-vision:/ultralytics/ultralytics/assets/bus.jpg ~/13store/bus.jpg 2>/dev/null || true
curl -s -H 'content-type: image/jpeg' --data-binary @$HOME/13store/bus.jpg http://127.0.0.1:8601/detect
```

ควรเห็น `person` 4 คนกับ `bus` 1 คัน

ยังไม่มีโมเดลหรือ GPU ก็ลองสายได้ด้วย `python3 vision_server.py --fake` บริการจะตอบเป็นคนเดินผ่านภาพทุก 6 วินาที

## 4. Gateway โหมดกล่อง AI (ไม่ต้องใช้ sudo)

บนเครื่องที่มีโปรเจกต์ ให้สั่ง `npm run kit:pi` แล้วคัดลอกไฟล์เหล่านี้ไปไว้ที่ `~/13store/edge/` บน Jetson:
- `deploy/pi/dist/13store-edge-pi/edge-gateway.mjs`
- `deploy/jetson/site.ai-box.example.json` (เปลี่ยนชื่อเป็น `site.json`)
- `deploy/jetson/set-key.sh`
- `deploy/jetson/13store-edge.service`

```bash
# Node 22 ในโฟลเดอร์ของผู้ใช้ (Ubuntu 22.04 มี Node เก่าเกินไป)
mkdir -p ~/13store/node && cd ~/13store/node
V=v22.23.4; F=node-$V-linux-arm64.tar.xz
curl -fsSLO https://nodejs.org/dist/$V/$F && curl -fsSLO https://nodejs.org/dist/$V/SHASUMS256.txt
grep " $F\$" SHASUMS256.txt | sha256sum -c - && tar -xJf $F && ln -sfn node-$V-linux-arm64 current

# ตั้งค่า: แก้ serverUrl (เช่น ws://192.168.20.13:8090) กับ geo ให้ตรงกับไซต์ (หน้าแอดมิน › ไซต์)
nano ~/13store/edge/site.json

# บริการให้เริ่มเอง
mkdir -p ~/.config/systemd/user && cp ~/13store/edge/13store-edge.service ~/.config/systemd/user/
systemctl --user daemon-reload

# ใส่คีย์ gateway จากขั้นที่ 1 (วางแล้วจะไม่มีตัวอักษรขึ้น) สคริปต์จะเก็บคีย์แบบอ่านได้เฉพาะผู้ใช้นี้ แล้วเริ่ม gateway
bash ~/13store/edge/set-key.sh
```

ค่าใน `aiBox` ที่ปรับได้:
- `capacity`: รับรถพร้อมกันได้กี่คัน
- `fps`, `width`: ดึงภาพแต่ละคันกี่ภาพต่อวินาที และกว้างกี่พิกเซล
- `vision.zones`: ค่าเริ่มต้นเป็นโซนคุ้มกันเต็มภาพ คนที่เห็นจึงนับเป็นผู้บุกรุก
- `minConfidence`, `cooldownS`: ความมั่นใจขั้นต่ำ และเว้นช่วงกี่วินาทีก่อนเปิดเหตุซ้ำ

แก้แล้วสั่ง `systemctl --user restart 13store-edge`

ดู log ด้วย `journalctl --user -u 13store-edge -f` ควรเห็น:
- `AI box (up to 2 videos; http): waits for the server to hand it videos`
- `connected to ws://… as jetson-ai-01`
- พอมีคนกดสวิตช์: `AI box: analysing UGV-01`

## 5. ใช้งาน

ศูนย์ควบคุม › เลือกรถ › **ห้องบังคับ** › กดสวิตช์ **AI ปิด** ให้เป็น **AI เปิด** (หรือ อุปกรณ์ › รถ › แท็บกล้อง)
- ชิป AI ขึ้นว่า "AI เฝ้าดูอยู่ · n fps"
- เดินเข้าหน้ากล้อง จะขึ้นกรอบแดง "บุกรุก xx% · #n" ชิปเป็น "ผู้บุกรุก 1" และระบบเปิดเหตุพร้อมรูป
- กดสวิตช์อีกครั้งเพื่อปิด

## ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| ชิปขึ้น "ไม่มีกล่อง AI ต่ออยู่" | gateway บน Jetson ไม่ได้ต่อ: `systemctl --user status 13store-edge`, `journalctl --user -u 13store-edge` ถ้าขึ้น `server refused the gateway credential` ให้รัน `set-key.sh` ใหม่ด้วยคีย์ที่ถูกต้อง |
| ชิปขึ้น "กล่อง AI เต็ม" | รถที่เปิด AI เกิน `capacity` ปิด AI คันที่ไม่ใช้ หรือเพิ่ม `capacity` (และโหมดพลังงาน) แล้ว restart gateway |
| กดเปิดแล้วขึ้นว่ารถไม่ได้ส่งภาพขึ้นเซิร์ฟเวอร์วิดีโอ | รถคันนั้นไม่ได้ส่งภาพเข้าเซิร์ฟเวอร์วิดีโอ ตรวจ gateway ของรถ (ภาพในห้องบังคับต้องขึ้นก่อน) |
| ชิปขึ้น "AI ไม่ได้รับภาพ" | กล่องได้งานแล้ว แต่ยังอ่านภาพไม่ได้ เช่น รถปิดอยู่ หรือส่งภาพไม่ขึ้น ดู log หาข้อความ ffmpeg |
| ชิปขึ้น "โมเดล AI ไม่ตอบ" | บริการ AI ไม่ทำงาน: `curl http://127.0.0.1:8601/health`, `docker logs 13store-vision` gateway จะลองใหม่เองทุก 2 วินาที |
| กรอบช้ากว่าภาพเล็กน้อย | ปกติ ภาพต้องผ่านรีโมตและเซิร์ฟเวอร์ก่อน (0.3–1 วินาที) |
| คนเยอะจนเปิดเหตุถี่ | เพิ่ม `cooldownS` หรือ `minConfidence` หรือวาดโซน `ignore` ตรงทางเดินคนดู |

## ไลเซนส์ของโมเดล

YOLOv8 และ YOLO11 ของ Ultralytics ใช้ไลเซนส์ **AGPL-3.0** ใช้เดโมและทดสอบได้ แต่ถ้าจะขายในผลิตภัณฑ์
ต้องซื้อไลเซนส์ Enterprise จาก Ultralytics หรือเปลี่ยนไปใช้โมเดลไลเซนส์เปิด เช่น YOLOX หรือ RT-DETR
(Apache-2.0) บริการ AI นี้รับโมเดลอื่นได้ ขอแค่ตอบรูปแบบเดิม (`label`, `confidence`, `box`)
