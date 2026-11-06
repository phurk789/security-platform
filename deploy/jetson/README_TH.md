# AI กล้องบน Jetson (Orin Nano / Orin NX)

ให้ Jetson เป็น "กล่อง AI" ที่บูธหรือห้องควบคุม: ดึงภาพกล้องของรถจากเซิร์ฟเวอร์วิดีโอ รันโมเดลบน GPU
แล้วส่งกรอบสดและเหตุกลับไปที่ระบบ บนรถไม่ต้องแก้อะไร ใช้ในอาคารได้เพราะไม่ต้องใช้ GPS

```
กล้องรถ ─(SIYI)─> รีโมต/Pi ──ส่งภาพ──> เครื่อง server (ระบบ + เซิร์ฟเวอร์วิดีโอ)
                                          │    ▲
                         ภาพของรถ (RTSP)  │    │ กรอบสด + เหตุ (WebSocket)
                                          ▼    │
                        Jetson: gateway (UGV-01-AI) ⇄ บริการ AI 127.0.0.1:8601 (GPU)
```

- **Gateway** บน Jetson เป็นตัวเดียวกับที่ใช้บนรถ ทำหน้าที่อุปกรณ์ "AI กล้อง" (`UGV-01-AI`) ที่ติดตามรถ `UGV-01`
- เซิร์ฟเวอร์ให้ **สิทธิ์อ่านภาพ** ของรถคันนั้นคันเดียวเอง ตอนที่ gateway เชื่อมต่อ ไม่ต้องใส่ที่อยู่กล้องหรือรหัสในไฟล์ตั้งค่า
- **บริการ AI** (`vision_server.py`) รับภาพ JPEG ตอบกรอบกลับ งานโซน ติดตามเป้า และเปิดเหตุอยู่ที่ gateway กับระบบ

## สิ่งที่ต้องมี

- Jetson Orin Nano หรือ Orin NX ลง **JetPack 6** (Ubuntu 22.04) แล้ว ต่อสาย LAN วงเดียวกับเครื่อง server
- เครื่อง server ที่รันระบบพร้อมเซิร์ฟเวอร์วิดีโอ (ตั้ง `MEDIA_INGEST_URL` และ `MEDIA_PUBLIC_URL` แล้ว) และรถที่ส่งภาพขึ้นเซิร์ฟเวอร์อยู่แล้ว
- บัญชีแอดมินของระบบ

## 1. ลงทะเบียนในหน้าแอดมิน (ทำครั้งเดียว)

1. **อุปกรณ์ใหม่:** รหัส `UGV-01-AI` ประเภท CCTV รุ่นใส่ว่า "AI กล้อง Jetson"
2. **คีย์ API › สร้างคีย์ประเภท gateway** ชื่อ "Jetson AI" แล้วจดคีย์ไว้ (แสดงครั้งเดียว)

## 2. ตั้งเครื่อง Jetson ให้แรงสุด

```bash
sudo nvpmodel -m 0
sudo jetson_clocks
docker info | grep -i nvidia     # ต้องเห็น nvidia (JetPack 6 มี nvidia-container มาให้แล้ว)
```

## 3. บริการ AI

**ลองสายก่อนด้วยโหมดทดสอบ** ไม่ต้องมีโมเดลหรือ GPU บริการจะตอบเป็นคนเดินผ่านภาพทุก 6 วินาที:

```bash
python3 vision_server.py --fake
curl http://127.0.0.1:8601/health          # {"ok": true, "model": "fake (no model)"}
```

**ใช้โมเดลจริงบน GPU** ด้วยคอนเทนเนอร์ Ultralytics สำหรับ Jetson:

```bash
sudo mkdir -p /opt/13store-vision
sudo cp vision_server.py /opt/13store-vision/

# สร้าง TensorRT engine บนเครื่องนี้ (ครั้งเดียว 5–10 นาที ไฟล์ yolov8s.pt จะถูกดาวน์โหลดให้เอง)
sudo docker run --rm --runtime nvidia --ipc=host -v /opt/13store-vision:/work -w /work \
  ultralytics/ultralytics:latest-jetson-jetpack6 \
  yolo export model=yolov8s.pt format=engine half=True imgsz=640

# รันบริการ แล้วให้เริ่มเองทุกครั้งที่เปิดเครื่อง
sudo docker run -d --name 13store-vision --restart unless-stopped --runtime nvidia --ipc=host \
  -p 127.0.0.1:8601:8601 -v /opt/13store-vision:/work -w /work \
  ultralytics/ultralytics:latest-jetson-jetpack6 \
  python3 vision_server.py --host 0.0.0.0 --model /work/yolov8s.engine

curl http://127.0.0.1:8601/health          # {"ok": true, "model": "yolov8s.engine"}
sudo docker logs -f 13store-vision
```

- engine ต้องสร้างบน Jetson เครื่องที่จะใช้ (ผูกกับ GPU และ TensorRT ของเครื่องนั้น) ย้ายไปเครื่องอื่นไม่ได้
- ลองแล้วใช้ได้ ให้จดเวอร์ชันของอิมเมจแล้วใช้แท็กนั้นแทน `latest-…` วันงานจะได้ไม่เปลี่ยนเอง
- Orin Nano ได้ yolov8s ที่ 640 ราว 30 ภาพ/วิขึ้นไป ถ้าต้องการเห็นคนไกลแม่นขึ้นลอง `yolov8m` (ช้ากว่า)

## 4. Gateway บน Jetson

ใช้ชุดติดตั้งเดียวกับ Raspberry Pi (ขั้นที่เป็นของ Pi โดยเฉพาะจะถูกข้ามเอง) แต่ต้องลง Node 20 ก่อน
เพราะ Ubuntu 22.04 มี Node เก่าเกินไป:

```bash
# บนเครื่องที่มีโปรเจกต์: npm run kit:pi  → ได้ deploy/pi/dist/13store-edge-pi.tar.gz คัดลอกมาที่ Jetson
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
tar xzf 13store-edge-pi.tar.gz && cd 13store-edge-pi && sudo bash install.sh
```

ตั้งค่า gateway จากไฟล์ตัวอย่าง:

```bash
sudo cp site.camera-ai.example.json /etc/13store-edge/site.json
sudo nano /etc/13store-edge/site.json
```

แก้ 3 จุด:
- `serverUrl` เป็นที่อยู่เครื่อง server เช่น `ws://192.168.1.10:8090`
- `key` เป็นคีย์ gateway จากขั้นที่ 1
- `geo` ให้ตรงกับจุดอ้างอิงของไซต์ (หน้าแอดมิน › ไซต์)

```bash
sudo systemctl restart 13store-edge
journalctl -u 13store-edge -f
```

ใน log ควรเห็น:
- `UGV-01-AI: waiting for the server to grant the video of UGV-01` ตามด้วย `registered 1 device(s)`
- `UGV-01-AI: started (http)` แปลว่าได้ภาพแล้ว

## 5. ตรวจบนหน้าเว็บ

ศูนย์ควบคุม › เลือก UGV-01 › **ห้องบังคับ**:
- HUD มีชิป **AI** ขึ้นว่า "AI เฝ้าดูอยู่ · n fps"
- เดินเข้าหน้ากล้อง จะขึ้นกรอบแดง "บุกรุก xx% · #n" ชิปเปลี่ยนเป็น "ผู้บุกรุก 1" และระบบเปิดเหตุพร้อมรูป
- อุปกรณ์ › UGV-01-AI › กล้อง จะเห็นสถานะ AI: โมเดล, fps, เวลาประมวลผลต่อภาพ

## ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| ชิปขึ้น "โมเดล AI ไม่ตอบ" | บริการ AI ไม่ทำงาน: `curl http://127.0.0.1:8601/health`, `sudo docker logs 13store-vision` · gateway จะลองใหม่เองทุก 2 วินาที |
| ชิปขึ้น "AI ไม่ได้รับภาพ" | ยังไม่ได้ภาพจากเซิร์ฟเวอร์: รถส่งภาพขึ้นอยู่ไหม (ห้องบังคับเห็นภาพไหม), เซิร์ฟเวอร์ตั้งเซิร์ฟเวอร์วิดีโอแล้วไหม, `journalctl -u 13store-edge` มีข้อความ ffmpeg ไหม |
| log ขึ้น `server rejected UGV-01-AI` | ยังไม่ได้ลงทะเบียน `UGV-01-AI` หรือใช้คีย์ผิดองค์กร (ขั้นที่ 1) |
| กรอบช้ากว่าภาพเล็กน้อย | ปกติ ภาพต้องผ่านรีโมตและเซิร์ฟเวอร์ก่อน (0.3–1 วินาที) ลดได้ด้วย `fps` ที่สูงขึ้นในไฟล์ตั้งค่า |
| คนเยอะเกินจนเปิดเหตุถี่ | เพิ่ม `cooldownS` หรือ `minConfidence`, หรือวาดโซน `ignore` ตรงทางเดินคนดู |

## ไลเซนส์ของโมเดล

YOLOv8 และ YOLO11 ของ Ultralytics ใช้ไลเซนส์ **AGPL-3.0** ใช้เดโมและทดสอบได้ แต่ถ้าจะขายในผลิตภัณฑ์
ต้องซื้อไลเซนส์ Enterprise จาก Ultralytics หรือเปลี่ยนไปใช้โมเดลไลเซนส์เปิด เช่น YOLOX หรือ RT-DETR
(Apache-2.0) บริการ AI นี้รับโมเดลอื่นได้ ขอแค่ตอบรูปแบบเดิม (`label`, `confidence`, `box`)
