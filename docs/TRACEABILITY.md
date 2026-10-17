# PRD R1 traceability and status

Status of every requirement in [`13STORE_Public_Security_PRD_R1.md`](13STORE_Public_Security_PRD_R1.md).

- **Done**: implemented and covered by an automated test.
- **Done (sim)**: implemented end to end against simulated devices. Needs the same test on real hardware.
- **Needs input**: cannot be finished from software alone (hardware, site data, legal, customer decision).

## §5 Requirements

| ID  | Requirement                                                                                  | Status     | Implementation                                                                                                                   | Tests                                                                           |
| --- | -------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| F01 | 2D map with 3D mode, selection kept, update time and source                                  | Done       | `apps/web/src/components/TwinMap.tsx` — one site model, two projections; device age, accuracy circles, source note               | Browser e2e                                                                     |
| F02 | Asset and device registry                                                                    | Done       | `devices` table; Admin → register; adapters declare model, capabilities, commands, limitations                                   | `security.test.ts` (gateway refuses unregistered devices)                       |
| F03 | Incident queue, edit type, merge duplicates, status by permission, actor and time            | Done       | `Platform.triage/confirm/dismiss/merge/editIncident/reopen`; timeline + audit                                                    | `acceptance.test.ts` (merge keeps evidence; reasons required)                   |
| F04 | LIVE / DELAYED / OFFLINE / REPLAY / SIMULATED labels; frozen frames never LIVE               | Done (sim) | `freshnessAt`, `FreshBadge`, `CameraFeed`, media frames label FEED DELAYED / NO SIGNAL                                           | Browser e2e; reducer tests                                                      |
| F05 | Approval; unauthorised users blocked in UI and API; material change needs re-approval        | Done       | `approveMission` (supervisor + step-up + constraint checks), `editRoute` resets approval                                         | `acceptance.test.ts` (dispatcher 403 via API; route change forces re-approval)  |
| F06 | Commands only for adapter capabilities; server re-checks                                     | Done       | `Device.commands` from adapter declaration; `issueCommand`                                                                       | `acceptance.test.ts`, gateway tests                                             |
| F07 | Command ID, idempotency key, expiry, issuer; retries never double-execute                    | Done       | `commands` table unique `(org, idempotency_key)`; adapter `CommandLedger`                                                        | `acceptance.test.ts` (3 parallel retries → 1 command); gateway tests            |
| F08 | One control holder; handover is logged                                                       | Done       | `controlOwner`, `acceptMission`, `handover` (supervisor, step-up), `release`                                                     | `acceptance.test.ts`, `security.test.ts`                                        |
| F09 | Last seen and data age; stale blocks new commands; no replay after reconnect                 | Done (sim) | 5 s stale / 15 s offline; start/resume refused; undelivered commands time out and are never re-sent                              | `acceptance.test.ts` (link loss end to end)                                     |
| F10 | Timeline with source and received time; files linked to incident and recorder                | Done       | `timeline` table (`at`, `receivedAt`); evidence `recordedBy`, `capturedAt`, `receivedAt`                                         | `acceptance.test.ts`                                                            |
| F11 | Report with incident, mission, approver, results, evidence refs; downloads logged            | Done       | `Platform.report`, `/incidents/:id/report`, audit `report.export`                                                                | `acceptance.test.ts`                                                            |
| F12 | Demo and pilot separated; simulated data labelled; replay cannot command                     | Done       | `ENV_MODE`, data label SIMULATION / MIXED DEMO / LIVE, demo env refuses non-simulated adapters, `X-Console-Mode: replay` refused | `acceptance.test.ts`, `security.test.ts`                                        |
| F13 | Cross-org/site denied; separate rights for video, export, control                            | Done       | Scope on every query; 404 outside scope; `media.view`, `evidence.export`, `device.command`                                       | `security.test.ts` (API, media URL, evidence, WebSocket)                        |
| F14 | Field mobile: accept, on scene, report, pending-sync state                                   | Done       | `apps/field` with outbox and idempotency keys                                                                                    | Field e2e (offline → sync, exactly one evidence item)                           |
| F15 | Search by incident, time, area, device; replay shows past time and disables commands         | Done       | Incidents page filters; `/incidents?…`; telemetry history; Replay bar                                                            | Browser e2e; `acceptance.test.ts` (replay refused)                              |
| F16 | Developer API with sandbox, per-environment credentials, capability contract, tested example | Done       | `/api/v1/openapi.json`, `docs/API.md`, sandbox org + keys, `docs/ADAPTER_CONTRACT.md`, `examples/custom-adapter.ts`              | `apps/gateway/test/example.test.ts`, `security.test.ts` (sandbox key isolation) |

### Hardware integrations

| Device                                                                      | Adapter                                                                                               | Status                                                                                 | Tests                                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| SIYI gimbal cameras (ZT30, ZR30, ZR10, ZT6, A8 mini)                        | `apps/gateway/src/real/siyiCamera.ts` (SIYI SDK, UDP 37260)                                           | **TESTING**: written to SIYI's published SDK, not yet run on hardware                  | `hardware.test.ts` (codec vectors, fake camera), `camera.test.ts` (control, permission, timeout, media auth)       |
| SIYI UniFC 6 Pico (PX4 / ArduPilot) via UniRC 7 Pro datalink                | `apps/gateway/src/real/mavlinkVehicle.ts` (MAVLink 2, UDP 19856)                                      | **TESTING**: not yet run on hardware                                                   | `hardware.test.ts` (fake ArduPilot rover: mission upload, start/stop, disarmed refusal, pilot override, link loss) |
| Live video (RTSP → WebRTC)                                                  | MediaMTX on the edge PC, `deploy/edge/`                                                               | **TESTING**                                                                            | `camera.test.ts` (token, path binding, expiry)                                                                     |
| ONVIF cameras (Profile S/T: fixed, PTZ, thermal; Hikvision, Dahua, Axis, …) | `apps/gateway/src/real/onvifCamera.ts` (SOAP 1.2, WS-UsernameToken, PTZ, snapshot, pull-point events) | **TESTING**: verified against a protocol-accurate fake camera, not yet run on hardware | `apps/gateway/test/onvif.test.ts`                                                                                  |
| Recordings (MediaMTX record + playback API)                                 | `Platform.recordings/clipUrl/clipToEvidence`, `deploy/edge/mediamtx.yml`                              | **TESTING**: fake playback server                                                      | `video.test.ts` (coverage, token-checked playback, clip → evidence)                                                |
| AI / sensor detections with per-organisation rules                          | `apps/server/src/detections.ts`, `Platform.ingestDetection`, Administration → Detection rules         | Done                                                                                   | `video.test.ts` (rules, cooldown merge, thermal threshold, gateway events, admin changes)                          |

Camera control in the console: pan/tilt pad (press and hold), zoom, photo, record, gimbal readout
and on-video OSD (`CameraControls.tsx`). Permission `camera.control` (dispatcher, supervisor,
operator); on vehicles only the control holder. The demo's CCTV-02 and UGV-01 run a simulated
SIYI gimbal so the flow can be shown without hardware. Hardware checklist: `docs/HARDWARE_SIYI.md`.

Unified UGV & UAV Command Center (`apps/web/src/views/CommandCenter.tsx`): one page per unit with
roster, onboard video plus heading/speed/altitude instruments, 3D twin following the unit,
telemetry, mission control (the same approval, control-holder and freshness rules as the incident
flow), camera control and an activity log. Twin HUD theme for the overview (`Hud.tsx`).

Camera-first efficiency: new alerts auto-point the nearest camera with line of sight (manual
control wins for 60 s); "Point at incident" button and `/devices/{id}/aim`; video pulled only
while watched, dropped when hidden; SD sub-stream by default with HD on request
(`camera.test.ts`, `reducer.test.ts`).

## §11 Acceptance checklist

| Check                                                                               | Status                                            | Where                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Merge duplicates without losing original evidence                                   | Done                                              | `acceptance.test.ts` → duplicates and evidence                              |
| Unauthorised users cannot command, even via API                                     | Done                                              | `acceptance.test.ts` → permissions                                          |
| Route change after approval forces review                                           | Done                                              | `acceptance.test.ts` → re-approval                                          |
| Network cut mid-mission: uncertain state shown; device enters its defined behaviour | Done (sim)                                        | `acceptance.test.ts` → network loss                                         |
| Reconnect does not run old commands or restart the mission                          | Done (sim)                                        | `acceptance.test.ts` → network loss                                         |
| Concurrent commanders locked out; handover recorded                                 | Done                                              | `security.test.ts` → step-up handover; control lock in `acceptance.test.ts` |
| Stop shows pending and confirmed separately; physical stop tested per device        | Software done. **Physical E-stop needs hardware** | `acceptance.test.ts`; booth plan                                            |
| Replay cannot send commands to real devices                                         | Done                                              | `acceptance.test.ts`                                                        |
| Exported report traces to incident, mission and evidence                            | Done                                              | `acceptance.test.ts` → end to end                                           |
| Restore from backup and check completeness                                          | Done                                              | `security.test.ts` → backup and restore                                     |

## §9 Quality targets

The numbers in §9 are test targets, not results. What exists today:

| Target                                             | Status                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Event shown ≤ 2 s p95 after the server receives it | Events are pushed over WebSocket immediately; not yet load-tested. Needs a defined pilot load profile                       |
| Stale telemetry detection (5 s default)            | Implemented and tested                                                                                                      |
| No duplicate execution on retry                    | Tested at server and adapter                                                                                                |
| Audit complete for critical commands               | Every command request, approval and result is audited; chain verified in tests                                              |
| Cross-area denial                                  | Tested for API, media URL, evidence and WebSocket                                                                           |
| Operational baseline                               | Reports page shows alert→verified, verified→approved, approved→started per incident. No targets set until a baseline exists |

## What still needs input before a pilot (§12)

These cannot be closed from code alone:

1. **Real device integration.** SIYI model, firmware, SDK/API and licence; UGV driver; camera
   streams. Write adapters against `docs/ADAPTER_CONTRACT.md` (the simulated UGV is the reference),
   then repeat the §11 tests on hardware, including the physical emergency stop.
2. **UAV.** Stays simulated until flight, airspace and controller behaviour pass separate tests.
3. **Site model.** Surveyed geometry, 3D model licence and the site-to-WGS 84 transform
   (placeholder geometry today).
4. **Video.** A streaming server behind the existing signed media-session endpoint.
5. **Identity.** Whether to connect the customer's identity provider (SSO/MFA). Today: local
   accounts, scrypt, lockout, step-up.
6. **Data policy.** Retention periods and deletion rules from legal; hosting location
   (on-premises vs cloud) after the network and data review.
7. **Load and security testing** on the pilot hardware and network: §9 latency targets, a
   penetration test, and a restore drill.
8. **Approvers and procedures.** Who approves which missions; booth staffing and safety plan.
