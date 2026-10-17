# 13STORE — Digital Twin for Public Security

A command-centre platform for checking alerts, approving and running UGV missions, and keeping
an auditable record, built from [`docs/13STORE_Public_Security_PRD_R1.md`](docs/13STORE_Public_Security_PRD_R1.md)
and [`docs/13STORE_Public_Security_UXUI_Concept_R1.md`](docs/13STORE_Public_Security_UXUI_Concept_R1.md).

It runs today end to end against **simulated devices** through a real edge-gateway protocol.
Real cameras, UGVs and UAVs connect by writing an adapter
([`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md)). Nothing in this repository claims a
hardware integration is ready.

## What's in it

| Part                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Command centre** (`apps/web`)      | Twin HUD overview (full-screen 3D city with floating glass panels, info callouts anchored to the selected building / vehicle / incident, selected-building glow, minimap with the camera's view wedge, map search, layer switches for buildings / traffic / routes / POI / zones / labels, and site overview cards — status, fleet link chart, coverage health, device states — when nothing is selected; Command / Operate / Review workspace tabs), **UGV & UAV Command Center** (unit roster, onboard video with drive/flight instruments, 3D follow view, telemetry, mission and camera control, activity log), situation map 2D/3D, incident queue and workflow, mission planner with constraint checks, live mission with command status, evidence and replay, reports, search, administration. Thai and English. |
| **Field app** (`apps/field`)         | Mobile web app for responders: accept, on scene, report with photos. Works offline and syncs without duplicates. Thai and English.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Platform server** (`apps/server`)  | REST API and WebSockets on SQLite. Sign-in, roles, org and site isolation, approvals, command certainty, evidence with checksums, hash-chained audit log, backups, signed media URLs, OpenAPI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Edge gateway** (`apps/gateway`)    | Runs device adapters on site and connects them to the server. Includes simulated UGV, UAV and CCTV adapters, **SIYI hardware adapters** (gimbal cameras over the SIYI SDK; UniFC 6 Pico / any PX4 or ArduPilot vehicle over MAVLink via the UniRC 7 Pro), and an SDK for your own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Shared rules** (`packages/shared`) | Roles, state machines, freshness thresholds and the wire protocol used by all of the above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Quick start

```bash
docker compose up --build        # server + separate simulated edge gateway
# or, from source (Node 22):
npm ci && npm run build && npm start
```

Open http://localhost:8080. Demo accounts, all with password `demo1234`:

| User      | Role            | Can                                                                     |
| --------- | --------------- | ----------------------------------------------------------------------- |
| `alex`    | Dispatcher      | Verify alerts, prepare missions, assign field responders, resolve       |
| `nida`    | Supervisor      | Approve missions, hand over control, export evidence                    |
| `somchai` | Operator        | Accept missions, command the UGV it controls                            |
| `kitti`   | Field responder | Field app at `/field/`                                                  |
| `priya`   | Auditor         | Read history, reports and audit, export evidence (no video, no control) |
| `ploy`    | Administrator   | Users, API keys, devices, backups (no incident data, no control)        |

In the demo environment you can switch between these users from the user menu.

No server? `npm run build:demo` produces `apps/web/dist-single/index.html`, a single file that
runs the whole scenario in the browser. It's the booth fallback, labelled SIMULATION · OFFLINE.

## Booth script (~3 min, UXUI §9)

| Time | Who          | Do                                                              | Shows                                                                      |
| ---- | ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0:00 | alex         | Map, KPIs, SIM tags                                             | One view of the site and devices that are actually ready                   |
| 0:30 | alex         | INC-024 → Open camera → Confirm                                 | An alert stays unverified until a person checks it                         |
| 1:00 | alex         | Prepare mission → UGV-01, route, operator → Submit for approval | Device chosen from real readiness; draft route dashed                      |
| 1:20 | nida         | Check constraints → Approve                                     | Only a supervisor can approve (password re-check after 15 min)             |
| 1:40 | somchai      | Accept mission → Send start request                             | Sent → acknowledged → confirmed; the vehicle moves only after confirmation |
| 2:10 | presenter    | Demo controls → Cut UGV-01 network, wait ~6 s, Restore          | STALE, start/resume held, failsafe stop, nothing replayed on reconnect     |
| 2:30 | somchai      | Resume → UGV reaches the gate, snapshot attached                | Evidence linked to the incident with a checksum                            |
| 2:45 | alex / priya | Resolve → Close → Reports → Export; Evidence → Replay           | Timeline, audit log, report export, replay with control off                |

Press **B** in the console for the **booth script**: _Next_ switches the role and performs each
step for you, with the talking point on screen; **A** runs the whole script as an attract loop.
Full booth playbook (risks, kit, run-of-show, answers): [`docs/BOOTH.md`](docs/BOOTH.md).
Optional: assign INC-022 to `kitti` and show the field app on a phone; inject a duplicate alert
and merge it.

## Documentation

| Doc                                                        | For                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md)             | Every PRD requirement and acceptance check, where it's implemented and tested, and what still needs input before a pilot                 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)             | Components, data model, server-side rules, command lifecycle, environments                                                               |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md)                 | Configuration, deployment, pilot checklist, backup and restore, security notes                                                           |
| [`docs/API.md`](docs/API.md)                               | API guide, developer sandbox, examples; full reference at `/api/v1/openapi.json`                                                         |
| [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md)     | How to connect a real device (BUILD YOUR OWN)                                                                                            |
| [`docs/INDOOR.md`](docs/INDOOR.md)                         | UGVs inside buildings: what indoor needs (positioning, floor maps, link, safety), what the platform does now, ROS 2 Nav2 setup           |
| [`docs/BIM.md`](docs/BIM.md)                               | Importing real building models (glTF from Revit / ArchiCAD / SketchUp / IFC) and an orthophoto into the twin; building information panel |
| [`docs/BOOTH.md`](docs/BOOTH.md)                           | Running the live demo at a booth: risks and mitigations, kit, run-of-show, answers                                                       |
| [`docs/HARDWARE_SIYI.md`](docs/HARDWARE_SIYI.md)           | Connecting SIYI cameras, the UniFC 6 Pico flight controller and the UniRC 7 Pro remote; edge PC and video setup; hardware test checklist |
| [`docs/VIDEO.md`](docs/VIDEO.md)                           | ONVIF cameras, recordings and clips through MediaMTX, AI / thermal detection ingest and rules                                            |
| [`docs/VEHICLES.md`](docs/VEHICLES.md)                     | Scheduled patrols, automatic route planning, geofences, usage counters and service, nearest-unit suggestion                              |
| [`docs/COMMAND_CENTRE.md`](docs/COMMAND_CENTRE.md)         | SOP playbooks with SLA stages, outbound notifications (webhook, LINE, SMS), operations KPIs and the period report                        |
| [`docs/GIS.md`](docs/GIS.md)                               | WGS 84 anchor, latitude/longitude in the console, GeoJSON export and geofence import                                                     |
| [`docs/SECURITY.md`](docs/SECURITY.md)                     | Security model, controls and status, deployment hardening checklist, standards mapping                                                   |
| [`docs/TOR_MAPPING.md`](docs/TOR_MAPPING.md)               | Typical Thai TOR requirements for a security command centre with patrol robots, mapped to features and evidence                          |
| [`docs/ENTERPRISE_ROADMAP.md`](docs/ENTERPRISE_ROADMAP.md) | Status of the six enterprise packages, next steps, licence tiers, services and support pricing (indicative)                              |

## Develop

```bash
npm ci
npm run dev                          # server on :8080 with the embedded simulated gateway
npm run dev -w @13store/web          # command centre on :5173 (proxies /api)
npm run dev -w @13store/field        # field app on :5174
npx tsc -b && npx vitest run         # typecheck and all tests
```

Tests cover the PRD §11 acceptance checks end to end against the real server and gateway:
permissions through the API, re-approval after route changes, idempotent retries, link loss with
failsafe and no replay, replay mode, organisation isolation (API, media URLs, WebSocket), field
responder scoping and offline dedupe, audit tamper detection, and backup/restore.

## Before a pilot

See the last section of [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md). In short: real device
adapters and hardware tests (including the physical emergency stop), the surveyed site model,
a video streaming server, the customer's identity and data-retention policy, TLS hosting, and
load and security testing.
