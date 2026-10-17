# TOR mapping — ระบบศูนย์บัญชาการความปลอดภัยพื้นที่สาธารณะด้วยยานยนต์ไร้คนขับ

How a typical Thai public-sector _Terms of Reference_ (ขอบเขตของงาน) for a smart-city security
command centre with patrol robots and drones maps onto this platform. Column **Status**: Done
(in code, tested), Done (sim) (works end to end with simulated devices; hardware run pending),
Pilot (needs the customer's site, network or devices), Service (delivered as project work).
**Evidence** names the document, screen or test a committee can check.

Use: copy the table into the bid's compliance matrix (ตารางเปรียบเทียบคุณสมบัติ), keep the TOR
clause numbers of the actual tender in the first column.

## A. ศูนย์บัญชาการและแผนที่ (command centre and map)

| #   | Requirement (ข้อกำหนดที่พบบ่อย)                                                                  | Status | Where                                                                   | Evidence                                                     |
| --- | ------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| A1  | แผนที่ 2 มิติ/3 มิติ (Digital Twin) แสดงอาคาร โซน อุปกรณ์ เหตุการณ์ ตามเวลาจริง                  | Done   | Overview → twin map, 3D mode, layers, minimap                           | `docs/BIM.md`, F01 in `TRACEABILITY.md`                      |
| A2  | นำเข้าแบบจำลองอาคาร (BIM/glTF) และภาพถ่ายทางอากาศ                                                | Done   | Administration / `apps/web/public/media`                                | `docs/BIM.md`                                                |
| A3  | รองรับพิกัดภูมิศาสตร์มาตรฐาน (WGS 84) และแลกเปลี่ยนข้อมูลกับ GIS ของหน่วยงาน (GeoJSON/Shapefile) | Done   | Administration → Site & GIS; `GET /sites/{id}/geojson`; geofence import | `docs/GIS.md`, `gis.test.ts` (Shapefile via QGIS conversion) |
| A4  | รับเหตุจากกล้อง CCTV/กล้องความร้อน/เซ็นเซอร์/AI analytics และระบบภายนอก                          | Done   | `POST /detections`, ONVIF events, detection rules                       | `docs/VIDEO.md`, `video.test.ts`                             |
| A5  | คิวเหตุการณ์ จัดลำดับความรุนแรง รวมเหตุซ้ำ ติดตามสถานะ ผู้รับผิดชอบ                              | Done   | Incident queue, triage/confirm/merge/dismiss                            | F03, `acceptance.test.ts`                                    |
| A6  | ขั้นตอนปฏิบัติมาตรฐาน (SOP) ต่อเหตุแต่ละประเภท พร้อมกรอบเวลา (SLA) และการแจ้งเตือนเมื่อเกินกำหนด | Done   | Playbooks, checklist, SLA chips, breach raising                         | `docs/COMMAND_CENTRE.md`, `ops.test.ts`                      |
| A7  | แจ้งเตือนภายนอก (LINE, SMS, ระบบอื่นผ่าน API/Webhook)                                            | Done   | Notification channels (signed webhook, LINE Messaging API, SMS gateway) | `COMMAND_CENTRE.md`, `ops.test.ts`                           |
| A8  | จอแสดงผลผนัง (video wall / kiosk) และโหมดนำเสนอ                                                  | Done   | Wall mode, show mode, ticker                                            | `docs/BOOTH.md`                                              |
| A9  | ภาษาไทยและอังกฤษ                                                                                 | Done   | TH / EN toggle, 1,100+ strings                                          | `apps/web/src/i18n-th.ts`                                    |
| A10 | รายงานสถิติ (KPI) รายวัน/รายเดือน ส่งออกได้                                                      | Done   | Reports → Operations KPIs, period report; incident report               | `COMMAND_CENTRE.md`, `/kpi/report`                           |

## B. วิดีโอและกล้อง (video)

| #   | Requirement                                                                     | Status     | Where                                      | Evidence                                                                |
| --- | ------------------------------------------------------------------------------- | ---------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| B1  | เชื่อมต่อกล้องมาตรฐาน ONVIF (Profile S/T) ยี่ห้อต่าง ๆ รวม PTZ และกล้องความร้อน | Done (sim) | `apps/gateway/src/real/onvifCamera.ts`     | `onvif.test.ts` against a protocol-accurate fake; hardware run in pilot |
| B2  | ภาพสดหน่วงต่ำในเบราว์เซอร์ (WebRTC) พร้อมป้าย LIVE/DELAYED/OFFLINE              | Done (sim) | MediaMTX + WHEP, `FreshBadge`              | `docs/VIDEO.md`, F04                                                    |
| B3  | บันทึกภาพย้อนหลัง เรียกดูช่วงเวลา และตัดคลิปเป็นหลักฐาน                         | Done (sim) | Recordings card, clip → evidence           | `video.test.ts`                                                         |
| B4  | ควบคุมกล้องกิมบอลและเล็งกล้องไปยังจุดเกิดเหตุ                                   | Done (sim) | Camera controls, _Point at INC-…_          | `camera.test.ts`, SIYI SDK adapter                                      |
| B5  | สิทธิ์ดูภาพแยกจากสิทธิ์สั่งการ และบันทึกการเข้าถึง                              | Done       | `media.view`, signed media sessions, audit | `security.test.ts`                                                      |

## C. ยานยนต์ภาคพื้นดินและอากาศยาน (UGV / UAV)

| #   | Requirement                                                             | Status          | Where                                           | Evidence                                                      |
| --- | ----------------------------------------------------------------------- | --------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| C1  | สั่งการหุ่นยนต์ตรวจตราหลายรุ่น/หลายผู้ผลิตผ่านมาตรฐานเดียว              | Done (sim)      | Adapter contract; MAVLink, ROS 2, SIYI adapters | `docs/ADAPTER_CONTRACT.md`, `hardware.test.ts`                |
| C2  | วางแผนเส้นทางอัตโนมัติหลบสิ่งกีดขวางและเขตหวงห้าม                       | Done            | A\* planner, `POST /routes/plan`                | `docs/VEHICLES.md`, `vehicles.test.ts`                        |
| C3  | เขตหวงห้าม/เขตระวัง/เขตห้ามบิน พร้อมแจ้งเตือนเมื่อล้ำเขต                | Done (sim)      | Geofences (UI, API, GeoJSON import)             | `vehicles.test.ts`, `gis.test.ts`                             |
| C4  | ตารางตรวจตราอัตโนมัติ (patrol schedule)                                 | Done (sim)      | Missions → Scheduled patrols                    | `vehicles.test.ts`                                            |
| C5  | เสนอหน่วยที่ใกล้ที่สุด/ถึงเร็วที่สุดเมื่อเกิดเหตุ                       | Done            | Nearest-unit ranking with ETA                   | `vehicles.test.ts`                                            |
| C6  | ขั้นตอนอนุมัติก่อนปล่อยยานยนต์ ผู้ควบคุมคนเดียว ส่งต่อการควบคุมมีบันทึก | Done            | Approval + step-up, control token, handover     | F05, F08                                                      |
| C7  | หยุดฉุกเฉิน แสดงสถานะรอยืนยัน/ยืนยันแล้ว                                | Done (software) | Stop command lifecycle                          | §11; physical E-stop tested on hardware in pilot              |
| C8  | ติดตามการใช้งาน ระยะทาง ชั่วโมงทำงาน รอบซ่อมบำรุง สถานีชาร์จ            | Done (sim)      | Devices → Usage / Service                       | `vehicles.test.ts`                                            |
| C9  | การทำงานภายในอาคาร                                                      | Pilot           | ROS 2 Nav2 setup, floor maps                    | `docs/INDOOR.md`                                              |
| C10 | อากาศยานไร้คนขับสำหรับเฝ้าตรวจ                                          | Done (sim)      | UAV overwatch in the twin; MAVLink adapter      | Flight permits and CAAT rules are the customer's; see roadmap |

## D. ความมั่นคงปลอดภัยและข้อมูลส่วนบุคคล (security and PDPA)

| #   | Requirement                                                           | Status       | Where                                                                                     | Evidence                                   |
| --- | --------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| D1  | ยืนยันตัวตนหลายปัจจัย / เชื่อมต่อระบบยืนยันตัวตนกลางของหน่วยงาน (SSO) | Done         | OpenID Connect, MFA at the IdP                                                            | `enterprise.test.ts`, `docs/OPERATIONS.md` |
| D2  | กำหนดสิทธิ์ตามบทบาท แยกผู้ดูแลระบบออกจากข้อมูลเหตุการณ์               | Done         | 6 roles, server-side enforcement                                                          | `docs/SECURITY.md` §1                      |
| D3  | บันทึกการใช้งาน (audit log) ที่แก้ไขไม่ได้ ตรวจสอบย้อนหลังได้         | Done         | Hash-chained audit, `/audit/verify`                                                       | `security.test.ts`                         |
| D4  | เข้ารหัสข้อมูลระหว่างส่งและข้อมูลสำคัญที่จัดเก็บ                      | Done / Pilot | TLS at the proxy, secrets sealed AES-256-GCM, hashed credentials; disk encryption by host | `SECURITY.md` §3–4, `hardening.test.ts`    |
| D5  | ป้องกันการโจมตีทั่วไป (brute force, XSS, clickjacking)                | Done         | Lockout, rate limits, CSP, security headers                                               | `hardening.test.ts`                        |
| D6  | นโยบายเก็บรักษาและลบข้อมูล และตอบคำร้องเจ้าของข้อมูลตาม PDPA          | Done         | Retention policy, privacy requests, erasure tombstones                                    | `OPERATIONS.md` → Retention and privacy    |
| D7  | สำรองและกู้คืนข้อมูล                                                  | Done         | Scheduled backups, verified restore                                                       | `security.test.ts`                         |
| D8  | ติดตั้งภายในหน่วยงาน (on-premises) หรือคลาวด์ในประเทศ                 | Pilot        | Single Node.js service + SQLite, container image                                          | `OPERATIONS.md`                            |
| D9  | ทดสอบเจาะระบบโดยบุคคลที่สาม                                           | Service      | Before go-live                                                                            | Roadmap item 6                             |

## E. การเปิดกว้างและการบูรณาการ (openness and integration)

| #   | Requirement                                                  | Status  | Where                                             | Evidence                          |
| --- | ------------------------------------------------------------ | ------- | ------------------------------------------------- | --------------------------------- |
| E1  | API มาตรฐาน (REST/OpenAPI) พร้อมเอกสารและสภาพแวดล้อมทดสอบ    | Done    | `/api/v1/openapi.json`, developer sandbox         | `docs/API.md`                     |
| E2  | ส่งออกข้อมูลมาตรฐานเปิด (JSON, GeoJSON, Markdown/PDF report) | Done    | Reports, GeoJSON, backups                         | `GIS.md`, `COMMAND_CENTRE.md`     |
| E3  | เชื่อมต่อระบบแจ้งเหตุ 191/1669 หรือศูนย์ของหน่วยงานอื่น      | Pilot   | Webhook / API to the receiving system             | Integration during implementation |
| E4  | ลิขสิทธิ์ซอฟต์แวร์และการต่ออายุ                              | Done    | Signed license file, limits, expiry and grace     | `OPERATIONS.md` → License         |
| E5  | การฝึกอบรมและคู่มือ                                          | Service | Operator, supervisor, admin courses; docs in repo | `ENTERPRISE_ROADMAP.md`           |

## F. คุณภาพการให้บริการ (quality targets)

| #   | Requirement                                             | Status     | Note                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | เหตุการณ์แสดงบนจอภายใน 2 วินาที (p95)                   | Done (sim) | Pushed over WebSocket immediately. Load harness (`npm run loadtest`), 100 cameras + 20 UGVs, 10 consoles: telemetry p95 24 ms, incident p95 21 ms (4× load: 86 ms), 100 % delivered; repeat on the pilot network — OPERATIONS.md → Load testing |
| F2  | ตรวจจับข้อมูลค้าง (stale) ภายใน 5 วินาที และห้ามสั่งการ | Done       | Tested                                                                                                                                                                                                                                          |
| F3  | ความพร้อมใช้งาน 99.5 %                                  | Pilot      | Single node + backups today; active/standby in roadmap item 6                                                                                                                                                                                   |
| F4  | รองรับกล้อง ≥ 100 ตัว อุปกรณ์ ≥ 50 ชิ้นต่อพื้นที่       | Done (sim) | Load harness ran 100 cameras + 20 UGVs on one site (and 480 devices) with 100 % delivery and no errors; limits are license-driven (demo unlimited). Pilot hardware will differ — OPERATIONS.md → Load testing                                   |

## Items that need the customer's decision before a pilot

Device models and firmware access, site survey (anchor, drawings, BIM), identity provider,
retention periods, hosting location, UAV permits, approvers and the booth/pilot safety plan — see
`TRACEABILITY.md` → _What still needs input_.
