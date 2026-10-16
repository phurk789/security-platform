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

| What | Value |
|---|---|
| Users | `dev` (dispatcher), `devop` (operator); password `demo1234` |
| Integration key | `sk_sandbox_demo_key` |
| Gateway key | `gw_sandbox_demo_key` |
| Registered device | `SBX-ROVER-01` (for your own adapter) |

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

Connect your own adapter to the sandbox (BUILD YOUR OWN):

```bash
SERVER_URL=ws://localhost:8080 npx tsx examples/run-custom-adapter.ts
```

## Live events

Open `ws://host/api/v1/ws`, send `{"type":"auth","token":"<session token>"}`, receive
`{"type":"hello",…}` and then events: `incident`, `mission`, `command`, `device`, `telemetry`,
`timeline`, `evidence`, `assignment`, `audit` (if permitted), `notice`, `resync` (reload the
snapshot). Events are filtered by the same organisation, site and role rules as the REST API.

## Replay

Clients showing past data send `X-Console-Mode: replay`. The server then refuses every change
with `409 replay_mode`. History comes from `GET /devices/{id}/telemetry?from&to` and the incident
timeline.
