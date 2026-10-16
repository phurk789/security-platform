# 13STORE — Digital Twin for Public Security (UX prototype)

Interactive prototype of the command-centre UI described in
[`docs/13STORE_Public_Security_PRD_R1.md`](docs/13STORE_Public_Security_PRD_R1.md) and
[`docs/13STORE_Public_Security_UXUI_Concept_R1.md`](docs/13STORE_Public_Security_UXUI_Concept_R1.md),
laid out after the concept mockup in [`docs/reference-mockup.png`](docs/reference-mockup.png).

This is **PRD step 2 (UX Prototype)**: every device, video feed and event is simulated in the browser.
There is no backend and no connection to real cameras, UGVs or UAVs. All devices are labelled
`SIMULATED`, and nothing here claims an integration is ready.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # domain rules (PRD §11 acceptance checks)
npm run build        # production build → dist/
npm run build:single # one self-contained HTML file → dist-single/index.html
```

## Booth script (~3 min, UXUI §9)

Switch roles from the user menu (top right). Presenter tools are under **Demo controls** (bottom right).

| Time | Who | Do this | Shows |
|---|---|---|---|
| 0:00 | Dispatcher (Alex) | Point at the map, KPIs, and SIM tags | One view of the site and devices that are actually ready |
| 0:30 | Dispatcher | INC-024 → **Open camera & start review** → **Confirm** | Alert stays *unverified* until a person checks it |
| 1:00 | Dispatcher | **Prepare mission** → pick UGV-01, route, operator → **Save draft** → **Submit for approval** | Device chosen from real readiness. Draft route is dashed |
| 1:20 | Supervisor (Nida) | Review constraint checks → **Approve** | Only a supervisor can approve |
| 1:40 | Operator (Somchai) | **Accept mission & take control** → **Send start request** | Command shows *Sent → Acknowledged → Confirmed*; the vehicle only moves after confirmation |
| 2:10 | Presenter | Demo controls → **Cut UGV-01 network**, wait ~6 s, then **Restore** | STALE badge, start/resume blocked, vehicle stops by failsafe, nothing replays on reconnect |
| 2:30 | Operator | **Resume** → UGV reaches the gate, snapshot attached | Evidence linked to the incident |
| 2:45 | Dispatcher | Record outcome → **Resolve** → **Close** → Reports / Evidence → **Replay** | Full timeline, audit log, report export; replay disables control |

Use **Reset demo dataset** before each run. Optional extras: **Inject duplicate gate alert** and merge it into
INC-024; edit the route after approval to force re-approval; switch to Auditor to show read-only.

## What the prototype enforces

The rules live in [`src/domain/reducer.ts`](src/domain/reducer.ts), which stands in for the server:
every action is re-checked there even when the UI already hid the button.

| PRD | Where |
|---|---|
| F01 2D/3D map keeps selection | `TwinMap` — one site model, two projections |
| F03 Incident queue, merge, dismiss with reason | `IncidentPanel` → `confirmIncident` / `mergeIncident` / `dismissIncident` |
| F04 LIVE / STALE / OFFLINE / REPLAY / SIMULATED | `FreshBadge`, `CameraFeed` (frozen frames never say LIVE) |
| F05 Approval, re-approval after edit | `approveMission`, `editRoute` |
| F06 Commands only if the adapter supports them | `Device.commands`, `issueCommand` |
| F07 Command ID, idempotency key, expiry | `Command`, duplicate keys ignored |
| F08 One control holder, logged handover | `controlOwner`, `acceptMission`, `handover` |
| F09 Stale data blocks new commands; no replay after reconnect | `freshness`, `demoRestoreLink`, failsafe pause |
| F10 Timeline with source and received time | `TimelineEvent`, Log tab |
| F11 Report and audit, export logged | `ReportsPage`, `exportReport` |
| F12 Demo vs real separated; replay can't command | SIMULATION/REPLAY badges, `guard()` blocks in replay |

Tests in [`src/domain/reducer.test.ts`](src/domain/reducer.test.ts) cover the PRD §11 checks that apply to a
front-end prototype (permissions, re-approval, idempotency, timeouts, reconnect, replay, full run).

## Not in this prototype

- Real device adapters, video, maps or 3D models. Site geometry is placeholder.
- Backend, authentication, multi-org scoping (F13), backup/restore, field mobile app (F14), developer API (F16).
- Thai UI strings. Fonts already support Thai (Noto Sans Thai); copy is English to match the mockup.

## Layout

```
src/
  domain/      types, scenario data, role/freshness policy, reducer (+ tests)
  components/  TwinMap, IncidentPanel, CameraFeed, Shell (top bar, nav, queue, timeline), Badges, Dialog
  views/       Incidents, Missions, Devices, Evidence & replay, Reports
docs/          PRD, UX/UI concept, reference mockup
```
