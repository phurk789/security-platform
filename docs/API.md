# API guide

Full reference: `GET /api/v1/openapi.json` (OpenAPI 3.1). Edge gateways: see
[`ADAPTER_CONTRACT.md`](ADAPTER_CONTRACT.md).

## Authentication

- **People:** `POST /api/v1/auth/login {username, password}` → `{token, expiresAt, user}`.
  Send `Authorization: Bearer <token>`.
- **Integrations:** an API key from Administration → API keys (`sk_<env>_…`). Integration keys
  can push alerts and read incidents in their organisation.
- **Edge gateways:** a gateway key (`gw_<env>_…`) on the WebSocket `/api/v1/gateway` only.

Sensitive actions (approve a mission, export evidence or reports, hand over control, admin
changes) answer `401 {"code":"step_up_required"}` when the last password check is older than
15 minutes. Call `POST /api/v1/auth/step-up {password}` and retry.

Errors are `{"error": "<message for people>", "code": "<machine code>"}` with codes
`unauthenticated`, `forbidden`, `step_up_required`, `not_found`, `invalid`, `conflict`,
`replay_mode`, `stale_telemetry`, `control_held`.

## Developer sandbox

The demo environment includes a separate organisation, **13STORE Developer Sandbox**:

| What              | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Users             | `dev` (dispatcher), `devop` (operator); password `demo1234` |
| Integration key   | `sk_sandbox_demo_key`                                       |
| Gateway key       | `gw_sandbox_demo_key`                                       |
| Registered device | `SBX-ROVER-01` (for your own adapter)                       |

Nothing in the sandbox can see or touch the demo organisation, and the reverse.

## Examples

Push an alert from a sensor system:

```bash
curl -s -X POST http://localhost:8080/api/v1/alerts \
  -H "Authorization: Bearer sk_sandbox_demo_key" -H "content-type: application/json" \
  -d '{"title":"Door forced","source":"Door sensor D-4","place":"Building 4","zone":"Zone B"}'
```

Sign in and list open incidents:

```bash
TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"dev","password":"demo1234"}' | jq -r .token)
curl -s "localhost:8080/api/v1/incidents?status=new,triaging" -H "Authorization: Bearer $TOKEN"
```

Send a command (operator who holds control of the mission's device):

```bash
curl -s -X POST localhost:8080/api/v1/commands -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"missionId":"SBX-MSN-0001","type":"start","idempotencyKey":"SBX-MSN-0001:start:0"}'
```

Re-sending the same `idempotencyKey` returns the same command. The response is the command
record; watch its `status` move through `sent → acknowledged → executing → succeeded`, or end
in `rejected`, `timed_out` or `unknown`. Only `succeeded` means the device confirmed.

Move a gimbal camera (dispatcher, supervisor or operator; on a vehicle, only the operator
holding control). The call waits up to 3 s for the camera:

```bash
curl -s -X POST localhost:8080/api/v1/devices/CCTV-02/camera -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"action":"gimbal_speed","yaw":40,"pitch":0}'
# → {"ok":true,"confirmed":true,"detail":"Gimbal moving."}
```

Actions: `gimbal_speed` (yaw, pitch −100…100; send 0,0 to stop), `gimbal_angle` (yaw ±135°,
pitch −90…25°), `center`, `zoom` (dir −1/0/1), `zoom_to` (level 1–30), `photo`, `record`
(toggle). `confirmed` is true only when the camera answered; `ok: true, confirmed: false` means
the request was sent but the camera did not reply. Every action is in the audit log.

Point a camera at an incident or a place (it turns and zooms; fixed cameras need a `mount`):

```bash
curl -s -X POST localhost:8080/api/v1/devices/CCTV-02/aim -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"incidentId":"INC-024"}'
# → {"ok":true,"confirmed":true,"aim":{"yaw":-0.3,"pitch":-6.4,"zoom":5.8,"distanceM":48},"lineOfSight":true,…}
```

New alerts with a position turn the nearest camera that can see them automatically (logged on
the incident timeline), unless an operator used that camera in the last minute.

Live video of a real camera: `POST /api/v1/media/{id}/session` returns `whep` (WebRTC) and
`hls` links (plus `whepSub` / `hlsSub` for a low-resolution sub-stream, if configured) on the site media server with a 60-second token. MediaMTX checks each viewer with
`POST /api/v1/media/auth` (`authMethod: http`); only `read` of that device's path is allowed.
See [`HARDWARE_SIYI.md`](HARDWARE_SIYI.md).

Connect your own adapter to the sandbox (BUILD YOUR OWN):

```bash
SERVER_URL=ws://localhost:8080 npx tsx examples/run-custom-adapter.ts
```

## Live events

Open `ws://host/api/v1/ws`, send `{"type":"auth","token":"<session token>"}`, receive
`{"type":"hello",…}` and then events: `incident`, `mission`, `command`, `device`, `telemetry`,
`timeline`, `evidence`, `assignment`, `audit` (if permitted), `notice`, `resync` (reload the
snapshot). Events are filtered by the same organisation, site and role rules as the REST API.

### Device equipment

`GET /api/v1/devices/:id` includes `components`: the parts the adapter declared
(`id`, `name`, `kind`, `version?`, `status`, `detail?`, `facing?` for cameras, `stream?`).
`status` is one of `ok | warn | fault | offline | pending`; `pending` means the interface to
that part has not been exercised yet. Gateways declare the list in `hello` and send changes in
telemetry as `components: [{id, status?, version?, detail?}]`; unknown ids are ignored, strings
are bounded and unknown kinds/statuses fall back to `other` / `pending`.

## Enterprise endpoints

- `GET /license` — license state (`valid` / `expiring` / `grace` / `expired` / `evaluation`), limits and usage.
  Registering a device or creating a user past a limit returns `402 {"code":"license"}`.
- `GET /auth/sso` → 302 to the identity provider; the callback lands on the console with `#sso=<session token>`.
  API clients keep using local accounts or API keys.
- `GET /ready`, `GET /metrics` — readiness and Prometheus metrics (see OPERATIONS.md → Monitoring).
- `GET|PATCH /admin/settings`, `POST /admin/retention/run`, `GET /admin/privacy?q=`, `POST /admin/privacy/erase` —
  retention policy and PDPA requests (OPERATIONS.md → Retention and privacy).

## Video: recordings and detections

- `GET /media/{id}/recordings?from&to` → `{ label: 'RECORDED' | 'SIMULATED', segments: [{start, end}], playback }`.
  Real cameras answer from the site media server's playback API; simulated ones from telemetry coverage.
- `POST /media/{id}/clip {start, duration}` → `{ url, mime, label, expiresAt }`: an MP4 link on the media server
  (viewer token, 60 s) or a storyboard SVG for simulated cameras. Audited `media.playback`.
- `POST /incidents/{id}/evidence/clip {deviceId, start, duration}` → evidence of kind `clip` with checksum
  (`evidence.add`, audited `evidence.clip`).
- `POST /detections` (integration key; one object or a list ≤ 100) → `{ id, outcome, incidentId?, ruleId? }`.
  Outcomes: `incident`, `merged`, `logged`, `ignored`, `duplicate`. See VIDEO.md for fields and rules.
- `GET /detections?from&to&deviceId&type&outcome&limit`, `GET /detections/stats`.
- Gateway adapters raise detections as `{ t: 'event', kind: 'detection', detection: {…} }` on the gateway channel
  (the ONVIF adapter does this for camera analytics events).

## Vehicles: routes, geofences, patrols, service

- `POST /routes/plan {deviceId, incidentId | to:{x,y}, via?}` → `{ ok, checkpoints, lengthM, etaS }`: a route around
  buildings and keep-out zones (through the service gate). `GET /incidents/{id}/suggest` ranks vehicles by ETA.
- `GET /geofences`; `POST /geofences`, `PATCH /geofences/{id}`, `DELETE /geofences/{id}` (`site.geofences`: supervisor,
  admin). Kinds `keep_out` (routes refused, breach raised), `caution` (noted), `no_fly` (aircraft). A mission route that
  enters an active keep-out zone is refused with `409 conflict`.
- `GET /patrols`; `POST /patrols`, `PATCH /patrols/{id}`, `DELETE /patrols/{id}`, `POST /patrols/{id}/run`
  (`patrol.manage`: supervisor, step-up). Body: `{ name, deviceId, operatorId, route, days: [0-6], times: ['HH:MM'],
autoStart, enabled }`. Each run raises an incident of type `Scheduled patrol` and an approved mission (`patrolId` set).
- `POST /devices/{id}/service {note}` (admin) and `PATCH /devices/{id}/stats {serviceIntervalM, serviceIntervalH, dock}`.
  `Device.stats` carries odometer, runtime, missions, service counters and `docked`. See VEHICLES.md.

## Replay

Clients showing past data send `X-Console-Mode: replay`. The server then refuses every change
with `409 replay_mode`. History comes from `GET /devices/{id}/telemetry?from&to` and the incident
timeline.
