# Enterprise roadmap and commercial model

Where the platform stands against the six enterprise work packages, what a pilot still needs, and
an indicative price list. Prices are in Thai baht, exclusive of VAT, **indicative** for proposal
work; the final quotation depends on the site survey and the TOR.

## 1. Status of the six packages

| #   | Package                                                                                                                                                                                                                                   | Delivered                                       | Remaining for a pilot                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| 1   | **Platform foundation** — signed licences with limits and grace, OpenID Connect SSO with role mapping, PDPA retention and data-subject requests, readiness and Prometheus metrics, scheduled verified backups                             | Done                                            | Customer IdP details; retention periods from the DPO                  |
| 2   | **Video** — ONVIF camera adapter (PTZ, snapshot, pull-point events), recordings and clips through MediaMTX playback, AI/thermal detection ingest with per-organisation rules                                                              | Done (verified against protocol-accurate fakes) | Run against the customer's cameras and NVR; edge PC sizing            |
| 3   | **Vehicles** — scheduled patrols with standing approval, A\* route planning around buildings and keep-out zones, geofences (keep-out / caution / no-fly) with live breach, usage counters, service records, docking, nearest-unit ranking | Done (sim)                                      | Hardware runs of the MAVLink and ROS 2 adapters; physical E-stop test |
| 4   | **Command centre** — SOP playbooks with SLA stages and breach raising, outbound notifications (signed webhook, LINE, SMS) with retry and delivery log, operations KPIs with period report                                                 | Done                                            | LINE Official Account and SMS gateway credentials                     |
| 5   | **GIS** — WGS 84 anchor per site with gateway consistency check, latitude/longitude everywhere, GeoJSON export of the whole site, geofence import from a GIS                                                                              | Done                                            | Survey of the real anchor; the customer's GIS layers                  |
| 6   | **Security hardening and tender pack** — secrets sealed at rest, rate limits, CSP and security headers, WebSocket origin control, clean dependency audit; SECURITY.md, TOR_MAPPING.md, this roadmap                                       | Done                                            | Third-party penetration test; active/standby deployment (below)       |

Test suite: 170+ automated tests across server, gateway, shared logic and browser flows
(`npm test`). Everything above runs today at https://thermal-inspection.vercel.app (offline
demo) and from `npm run dev` (full platform).

## 2. Next engineering steps (post-pilot)

| Step                                                                                        | Why                           | Effort                               |
| ------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------ |
| Active/standby server with replicated data directory (or PostgreSQL option)                 | 99.5 % availability clauses   | 6–8 weeks                            |
| Hardware runs: SIYI, UniFC 6 / ArduPilot rover, ONVIF cameras, MediaMTX on the edge PC      | Turn _Done (sim)_ into _Done_ | 4–6 weeks per vehicle model          |
| Indoor positioning and floor maps (ROS 2 Nav2)                                              | Indoor patrols                | 8–12 weeks with a partner integrator |
| Mobile field app packaging (PWA → store builds); push notifications are **Done** (Web Push) | Field responders              | 2 weeks                              |
| Report templates per agency (Thai PDF), e-signature                                         | Paper trail                   | 3 weeks                              |
| Load test and penetration test on the pilot network                                         | TOR quality targets           | 2 weeks + remediation                |

## 3. Licensing

Signed licence per organisation (`OPERATIONS.md → License`) with limits on sites, devices and
users and feature flags.

| Tier             | Sites     | Devices  | Users     | Features                                                             | Indicative price / year          |
| ---------------- | --------- | -------- | --------- | -------------------------------------------------------------------- | -------------------------------- |
| **Pilot**        | 1         | 15       | 10        | Core console, simulated + 1 real adapter, local accounts             | ฿ 1,200,000                      |
| **Professional** | up to 3   | 60       | 60        | + ONVIF, recordings, detections, playbooks, notifications, KPIs, GIS | ฿ 3,900,000                      |
| **Enterprise**   | unlimited | per site | unlimited | + SSO, API/sandbox, custom adapters, wall mode, priority support     | ฿ 7,500,000 + ฿ 650,000 per site |

Perpetual licence option: 2.5 × the annual price, with 18 % per year for updates and support.

## 4. Implementation services (per site unless noted)

| Service                                     | Scope                                                                          | Indicative                             |
| ------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| Site survey and twin set-up                 | Anchor, drawings, zones, geofences, BIM or orthophoto import, camera mounts    | ฿ 350,000 – 900,000                    |
| Edge kit                                    | Industrial PC, MediaMTX, UPS, LTE/5G failover, installation                    | ฿ 220,000                              |
| Camera integration                          | ONVIF onboarding, analytics rules, recording policy, per 20 cameras            | ฿ 180,000                              |
| Vehicle adapter                             | New UGV/UAV model against the adapter contract, including hardware test plan   | ฿ 600,000 – 1,500,000 per model (once) |
| Command-centre set-up                       | Playbooks, SLA, LINE/SMS/webhook, KPI report templates, wall layout            | ฿ 250,000                              |
| Integration to an external system           | 191/1669, city platform, SIEM (webhook/API mapping)                            | ฿ 300,000 – 800,000 each               |
| Training                                    | Operator (1 day), supervisor (½ day), administrator (1 day), train-the-trainer | ฿ 120,000 per class                    |
| Project management and documentation (Thai) | Plan, UAT, handover documents, as-built                                        | 12 % of services                       |

Vehicles, cameras and network are quoted separately from the hardware catalogue (`packages/shared/src/catalog.ts`).

## 5. Support

| Level    | Hours        | Response / restore                                    | Price           |
| -------- | ------------ | ----------------------------------------------------- | --------------- |
| Silver   | 8×5          | 4 h / next business day                               | 12 % of licence |
| Gold     | 24×7         | 1 h / 8 h                                             | 20 % of licence |
| Platinum | 24×7 on site | 30 min / 4 h, quarterly health review, named engineer | 30 % of licence |

## 6. Example programme (5 years, one province)

| Item                                                                 | Year 1       | Years 2–5 (each) |
| -------------------------------------------------------------------- | ------------ | ---------------- |
| Enterprise licence, 12 sites                                         | ฿ 15.3 M     | ฿ 15.3 M         |
| Implementation, 12 sites (survey, edge kit, cameras, command centre) | ฿ 14.4 M     | —                |
| Two vehicle adapters (UGV + UAV models)                              | ฿ 2.4 M      | —                |
| Integrations (191 centre, city GIS, SIEM)                            | ฿ 1.8 M      | —                |
| Gold support                                                         | ฿ 3.1 M      | ฿ 3.1 M          |
| Training (8 classes)                                                 | ฿ 1.0 M      | ฿ 0.25 M         |
| **Software and services**                                            | **฿ 38.0 M** | **฿ 18.65 M**    |

Five-year software and services value ≈ ฿ 112 M per province; vehicles and cameras (typically
2–3 × that) are sold alongside. Ten provinces over five years is the billion-baht programme the
roadmap is sized for.

## 7. What a buyer gets today

- Working software with an auditable record, not slides: every feature in §1 is demonstrable
  live, and every claim in `TOR_MAPPING.md` points at a screen, a document or a test.
- Clear labelling of what is simulated, so the pilot plan is honest about hardware steps.
- Documentation set: `README.md`, `ARCHITECTURE.md`, `OPERATIONS.md`, `SECURITY.md`, `API.md`,
  `ADAPTER_CONTRACT.md`, `VIDEO.md`, `VEHICLES.md`, `COMMAND_CENTRE.md`, `GIS.md`, `BIM.md`,
  `INDOOR.md`, `BOOTH.md`, `HARDWARE_SIYI.md`, `TRACEABILITY.md`, `TOR_MAPPING.md`.
