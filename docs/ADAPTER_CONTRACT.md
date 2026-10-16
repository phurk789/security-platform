# Device adapter contract (gateway protocol `ps-gw/1`)

For teams connecting a device to the 13STORE Public Security platform, including BUILD YOUR OWN builds.
An adapter runs inside the **Edge Gateway** on site. It talks to one device (vendor SDK, serial, radio,
simulator) and implements the `Adapter` interface from [`apps/gateway/src/sdk.ts`](../apps/gateway/src/sdk.ts).
The gateway owns the network link to the server.

A device counts as integrated only after it passes the checklist at the end of this doc on real hardware.
Until then, declare it `testing` or `simulated`. The platform labels it that way everywhere.

## 1. Declaration

Each adapter declares an `AdapterDeclaration` (`packages/shared/src/protocol.ts`). The gateway sends it to
the server in `hello`. The server only accepts device ids that an administrator has registered for that site.

| Field | Rule |
|---|---|
| `deviceId` | Must match the id registered on the server. |
| `kind` | `ugv`, `uav` or `cctv`. |
| `model`, `adapterVersion`, `protocolVersion`, `firmwareTested` | Exact versions you tested. `firmwareTested` says "not tested" when that is the truth. |
| `integration` | `verified` only after the checklist passes on hardware. Otherwise `testing` or `simulated`. |
| `capabilities` | What the device offers, e.g. `camera`, `ground_patrol`, `waypoints`. |
| `commands` | Only commands the device really executes (`start`, `pause`, `resume`, `stop`). The server never sends anything else, and the UI shows no button for anything else (PRD F06). |
| `units` | Position in site metres (`site-m`), altitude in metres above the site datum, speed m/s, battery %. Convert in the adapter. Never mix altitude datums. |
| `rateMs` | Nominal telemetry interval. The server marks data stale after `max(5 s, 3 × rateMs)`. |
| `limitations` | Plain-language limits shown to supervisors before approval. |
| `linkLossBehavior` | What the device does by itself when the link drops. It must be tested on that device. |

## 2. Telemetry

Send `telemetry` at the declared rate:

```json
{ "t": "telemetry", "deviceId": "UGV-01", "seq": 812, "sourceTime": 1792188205123,
  "pos": { "x": 268.4, "y": 219.1 }, "accuracyM": 1.5, "battery": 81.6, "speed": 6,
  "quality": "good", "nextCp": 1 }
```

- `sourceTime` is when the device measured the value, not when you sent it. The server stores its own receive time beside it (PRD F10).
- `seq` increases by one per message. Gaps tell the server that data was lost.
- `accuracyM` is the honest horizontal error. The map draws an uncertainty circle from it. Never send a more precise position than the device knows.
- Never invent telemetry. If the device stops reporting, send nothing. The server shows STALE, then OFFLINE.
- The gateway does not buffer telemetry while the server link is down. Old positions are not replayed as if they were live.

## 3. Commands

Server → gateway:

```json
{ "t": "command", "commandId": "CMD-0042", "idempotencyKey": "MSN-0007:start:0",
  "deviceId": "UGV-01", "type": "start", "missionId": "MSN-0007",
  "expiresAt": 1792188215123, "route": [{ "x": 262, "y": 218 }, { "x": 334, "y": 228 }] }
```

Gateway → server, one message per status change:

```json
{ "t": "cmd", "commandId": "CMD-0042", "status": "acknowledged", "at": 1792188205420 }
{ "t": "cmd", "commandId": "CMD-0042", "status": "executing",    "at": 1792188205720 }
{ "t": "cmd", "commandId": "CMD-0042", "status": "succeeded",    "at": 1792188206020 }
```

Rules:

1. **Expiry.** If `now > expiresAt` when the command reaches the device, reply `rejected` and do nothing.
2. **Idempotency.** A repeated `idempotencyKey` never executes again. Re-report the status you already have. `CommandLedger` and `admitCommand()` in the SDK do this for you.
3. **Unsupported or wrong state.** Reply `rejected` with a `detail` the operator can act on, e.g. "Cannot resume while idle."
4. **Success means confirmed.** Send `succeeded` only when the device confirms the effect: moving for start/resume, speed 0 for pause/stop. If the effect does not happen, send `failed`.
5. **Silence is allowed.** If you cannot tell what happened, send nothing. The server shows *timed out* (no ack in 5 s) or *unknown*. It never shows success by itself.
6. **Stop request is not an emergency stop.** The physical E-stop and local control must work without the platform.

## 4. Link loss and reconnect

- The device must reach a safe state by itself when it loses the link. The simulated UGV stops in place after 1.5 s. A UAV follows its own flight-controller failsafe, configured per site.
- A command sent during the outage never reached the device. It must never run later.
- After reconnect the device must not resume a mission or replay anything by itself. Report what happened:

```json
{ "t": "event", "deviceId": "UGV-01", "kind": "failsafe_stop", "at": 1792188209870,
  "detail": "Stopped in place after link loss. Waiting for the operator to resume." }
```

Any resume comes from the operator as a new command with a new `commandId`.

## 5. Events

`kind` is one of `checkpoint`, `route_complete`, `snapshot`, `failsafe_stop` or `fault`. A `snapshot` can
carry a frame `{ "mime": "image/svg+xml" | "image/jpeg", "base64": "…" }`, which the server stores as
evidence with a SHA-256 checksum. Events raised while the device's own radio link is down may be held and
sent in time order once it is back. Command status updates from that period are not resent.

## 6. Session protocol

1. Connect a WebSocket to `wss://<server>/api/v1/gateway` with the header `Authorization: Bearer <gateway key>`. Keys are issued per environment (demo, sandbox, pilot) in Admin → API keys.
2. Send `hello`:
   ```json
   { "t": "hello", "protocol": "ps-gw/1", "gatewayId": "edge-civic-01", "adapters": [ { "deviceId": "UGV-01", "...": "…" } ] }
   ```
3. The server answers `welcome` with `accepted` and `rejected` device ids. Only accepted devices may send telemetry or receive commands.
4. The server may send `demo` (`cut_link`, `restore_link`, `reset`) to simulators. Real adapters ignore it. `deviceId: "*"` targets every adapter.
5. On disconnect the gateway reconnects with backoff (250 ms doubling to 5 s) and sends `hello` again.

## 7. Test checklist before declaring `verified` (PRD §11)

| Check | How |
|---|---|
| Retry does not execute twice | Send the same command twice with one `idempotencyKey`. The device moves once. |
| Expired command not executed | Send with `expiresAt` in the past. Expect `rejected` and no motion. |
| Unauthorised user cannot command | Covered by the server. Confirm the adapter only acts on gateway messages, with no side channel. |
| Network cut mid-mission | Pull the link. The device reaches its declared safe state. The server shows STALE and then unknown or timed out. |
| Reconnect does not resume or replay | Restore the link. The device stays stopped, reports `failsafe_stop`, and nothing sent during the cut runs. |
| Stop shows pending, then confirmed | `succeeded` only after measured speed is 0. Test the physical E-stop per the device plan. |
| Position accuracy is honest | Compare reported `accuracyM` with surveyed points. |
| Units and datum | Positions are in site metres after your transform. Altitude uses the site datum. |

A tested example is in [`examples/custom-adapter.ts`](../examples/custom-adapter.ts), exercised by
`apps/gateway/test/example.test.ts`.
