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

| Field                                                          | Rule                                                                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceId`                                                     | Must match the id registered on the server.                                                                                                                                  |
| `kind`                                                         | `ugv`, `uav` or `cctv`.                                                                                                                                                      |
| `model`, `adapterVersion`, `protocolVersion`, `firmwareTested` | Exact versions you tested. `firmwareTested` says "not tested" when that is the truth.                                                                                        |
| `integration`                                                  | `verified` only after the checklist passes on hardware. Otherwise `testing` or `simulated`.                                                                                  |
| `capabilities`                                                 | What the device offers, e.g. `camera`, `ground_patrol`, `waypoints`.                                                                                                         |
| `commands`                                                     | Only commands the device really executes (`start`, `pause`, `resume`, `stop`). The server never sends anything else, and the UI shows no button for anything else (PRD F06). |
| `units`                                                        | Position in site metres (`site-m`), altitude in metres above the site datum, speed m/s, battery %. Convert in the adapter. Never mix altitude datums.                        |
| `rateMs`                                                       | Nominal telemetry interval. The server marks data stale after `max(5 s, 3 × rateMs)`.                                                                                        |
| `limitations`                                                  | Plain-language limits shown to supervisors before approval.                                                                                                                  |
| `linkLossBehavior`                                             | What the device does by itself when the link drops. It must be tested on that device.                                                                                        |

## 2. Telemetry

Send `telemetry` at the declared rate:

```json
{
  "t": "telemetry",
  "deviceId": "UGV-01",
  "seq": 812,
  "sourceTime": 1792188205123,
  "pos": { "x": 268.4, "y": 219.1 },
  "accuracyM": 1.5,
  "battery": 81.6,
  "speed": 6,
  "quality": "good",
  "nextCp": 1
}
```

- `sourceTime` is when the device measured the value, not when you sent it. The server stores its own receive time beside it (PRD F10).
- `seq` increases by one per message. Gaps tell the server that data was lost.
- `accuracyM` is the honest horizontal error. The map draws an uncertainty circle from it. Never send a more precise position than the device knows.
- Never invent telemetry. If the device stops reporting, send nothing. The server shows STALE, then OFFLINE.
- The gateway does not buffer telemetry while the server link is down. Old positions are not replayed as if they were live. It counts what it drops and logs the count when the link is back (§7).

## 3. Commands

Server → gateway:

```json
{
  "t": "command",
  "commandId": "CMD-0042",
  "idempotencyKey": "MSN-0007:start:0",
  "deviceId": "UGV-01",
  "type": "start",
  "missionId": "MSN-0007",
  "expiresAt": 1792188215123,
  "route": [
    { "x": 262, "y": 218 },
    { "x": 334, "y": 228 }
  ]
}
```

Gateway → server, one message per status change:

```json
{ "t": "cmd", "commandId": "CMD-0042", "status": "acknowledged", "at": 1792188205420 }
{ "t": "cmd", "commandId": "CMD-0042", "status": "executing",    "at": 1792188205720 }
{ "t": "cmd", "commandId": "CMD-0042", "status": "succeeded",    "at": 1792188206020 }
```

Rules:

1. **Expiry.** If `now > expiresAt` when the command reaches the device, reply `rejected` and do nothing.
2. **Idempotency.** A repeated `idempotencyKey` never executes again, also after a gateway restart. Re-report the status you already have. Pass `ctx.ledger` to `admitCommand()` and record each status change in it: the gateway keeps that ledger on disk (§7).
3. **Unsupported or wrong state.** Reply `rejected` with a `detail` the operator can act on, e.g. "Cannot resume while idle."
4. **Success means confirmed.** Send `succeeded` only when the device confirms the effect: moving for start/resume, speed 0 for pause/stop. If the effect does not happen, send `failed`.
5. **Silence is allowed.** If you cannot tell what happened, send nothing. The server shows _timed out_ (no ack in 5 s) or _unknown_. It never shows success by itself.
6. **Stop request is not an emergency stop.** The physical E-stop and local control must work without the platform.

## 4. Link loss and reconnect

- The device must reach a safe state by itself when it loses the link. The simulated UGV stops in place after 1.5 s. A UAV follows its own flight-controller failsafe, configured per site.
- A command sent during the outage never reached the device. It must never run later.
- After reconnect the device must not resume a mission or replay anything by itself. Report what happened:

```json
{ "t": "event", "deviceId": "UGV-01", "kind": "failsafe_stop", "at": 1792188209870, "detail": "Stopped in place after link loss. Waiting for the operator to resume." }
```

Any resume comes from the operator as a new command with a new `commandId`.

### 4.1 Live driving (optional, ground vehicles)

An adapter that declares `teleop: { maxThrottle, maxSteer, deadmanMs }` can be driven from the console.
The server lets an operator open a drive session only in `LIVE_MANUAL` (simulators: `SIMULATION`), with
fresh telemetry and no running mission, and then forwards their stick samples (about ten a second):

```json
{ "t": "drive", "deviceId": "UGV-01", "seq": 42, "throttle": 0.6, "steer": -0.2, "at": 1792188209870 }
```

`throttle` and `steer` are −1…1 of full stick, before the adapter's caps. The adapter must:

- apply its own caps (the declared `maxThrottle` / `maxSteer`), never trusting the server for them;
- ignore samples with a `seq` at or below the last one it applied;
- stop the vehicle when no sample arrived for `deadmanMs`, and hand control back to the vehicle's own remote soon after;
- after any stop (dead-man, disarmed, mode changed) obey only once a centred sample arrives;
- on `"release": true`, stop and hand control back at once;
- never fight the pilot: drive only while the vehicle is armed in a manual mode, and let go when the pilot changes mode.

`apps/gateway/src/drive.ts` (`DriveState`) implements the ordering, dead-man and centring rules; the MAVLink
adapter turns samples into `RC_CHANNELS_OVERRIDE` on the steering and throttle channels only.

## 5. Events

`kind` is one of `checkpoint`, `route_complete`, `snapshot`, `failsafe_stop` or `fault`. A `snapshot` can
carry a frame `{ "mime": "image/svg+xml" | "image/jpeg", "base64": "…" }`, which the server stores as
evidence with a SHA-256 checksum. Events raised while the device's own radio link is down may be held and
sent in time order once it is back. Command status updates from that period are not resent.

## 6. Session protocol

1. Connect a WebSocket to `wss://<server>/api/v1/gateway` with the header `Authorization: Bearer <gateway key>`. Keys are issued per environment (demo, sandbox, pilot) in Admin → API keys.
2. Send `hello`:
   ```json
   { "t": "hello", "protocol": "ps-gw/1", "gatewayId": "edge-civic-01", "adapters": [{ "deviceId": "UGV-01", "...": "…" }] }
   ```
3. The server answers `welcome` with `accepted` and `rejected` device ids. Only accepted devices may send telemetry or receive commands.
4. The server may send `demo` (`cut_link`, `restore_link`, `reset`) to simulators. Real adapters ignore it. `deviceId: "*"` targets every adapter.
5. On disconnect the gateway reconnects with backoff (250 ms doubling to 5 s) and sends `hello` again.

## 7. Command ledger across restarts

The gateway gives each adapter a `CommandLedger` as `ctx.ledger` ([`apps/gateway/src/ledger.ts`](../apps/gateway/src/ledger.ts)).
`admitCommand()` saves a command to it **before** the adapter acts on it, so a command that ran is on disk
even if the gateway dies a moment later. After a restart, a re-delivered command is re-reported, never run again.

| Item       | Rule                                                                                                                                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location   | `<GATEWAY_DATA_DIR>/ledger/<deviceId>.json`, one file per device. `GATEWAY_DATA_DIR` defaults to `$DATA_DIR/gateway` (`/data/gateway` in the Docker image), else `./data/gateway`. A device id that is not a plain file name gets `id-<sha256 prefix>.json`.                                                                       |
| Storage    | Must survive a restart **and** a container re-create: a host directory or a named volume, writable by the gateway user (uid 1000 in the image). The container's own filesystem is not enough. `deploy/edge/docker-compose.yml` mounts the named volume `gateway-data` at `/data`.                                         |
| Writes     | The whole file on every change: a temp file in the same directory, `fsync`, rename over the old file, then `fsync` of the directory (skipped on Windows). A crash leaves the old or the new file, never a mix. Stray `*.tmp` files are deleted at start. The file is created at start, so an unwritable directory shows up at once. |
| Retention  | An entry is kept 10 min after its last update (`LEDGER_RETAIN_MS`, 60× the 10 s `COMMAND_TTL_MS`). Dedupe only needs it until the command expires; the longer retention means a late re-delivery gets the status the device really reported, not "expired, not executed".                                                         |
| Size bound | At most 1,000 entries per device (`LEDGER_MAX_ENTRIES`), oldest dropped first. An entry whose command could still be admitted (now ≤ `expiresAt` + 2 s clock skew) is never dropped, by retention or by the bound: forgetting it would let the command run twice. A flood can therefore exceed the bound briefly (logged once).   |

```json
{
  "format": "ps-gw-ledger/1",
  "deviceId": "UGV-01",
  "savedAt": 1792188206020,
  "entries": [{ "key": "8f0c…", "commandId": "CMD-0042", "status": "succeeded", "expiresAt": 1792188215000, "at": 1792188206020 }],
  "sha256": "<hex SHA-256 of JSON.stringify(entries)>"
}
```

`status` is the last one the adapter recorded: `received` (admitted, no outcome yet), `acknowledged`,
`executing`, `succeeded`, `rejected` or `failed`. `expiresAt` is the command's (server clock), `at` the
last update (gateway clock).

**Fail-safe start.** If the file is missing, unreadable or corrupt (does not parse, unknown format, written
for another device, checksum mismatch, malformed entry), the gateway logs why and treats every command that
may have been issued before it started as already seen with an unknown outcome. It does not run it and sends
nothing, so the server shows _timed out_ (rule 5). The server sets `expiresAt = issuedAt + COMMAND_TTL_MS`,
so these are exactly the commands with `expiresAt ≤ start + 10 s + 2 s`, and the window closes by itself
about 12 s after the start. A corrupt file is kept as `<file>.corrupt-<ms>` for inspection and replaced by an
empty ledger. This relies on the gateway clock being within 2 s of the server's: run NTP on the Edge PC.

**If the file cannot be written** (disk full, read-only volume), `start` and `resume` are rejected with
"The gateway cannot save its command ledger…", because after a restart nothing would stop them running a
second time. `stop` and `pause` still run: running them twice cannot move the vehicle. The error is logged
once, and again when saving works.

**Without a data directory** (`startGateway()` without `dataDir`: tests and the server's embedded simulator)
ledgers stay in memory, as before. An adapter that creates its own `new CommandLedger()` also gets a
memory-only ledger: use `ctx.ledger`.

**Telemetry is not persisted or buffered.** It is still dropped while the server link is down: the server
judges freshness by when a sample arrives, so a replayed sample would look live. The gateway counts what it
drops by message type (`GatewayHandle.dropped`) and logs each outage when the link is back, for example
`dropped during 12.4 s offline (not buffered): 118 telemetry, 1 cmd`. Lost `cmd` or `event` messages are
logged as a warning.

## 8. Test checklist before declaring `verified` (PRD §11)

| Check                               | How                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Retry does not execute twice        | Send the same command twice with one `idempotencyKey`. The device moves once.                                    |
| Gateway restart does not re-run     | Restart the gateway while a command runs, then re-send it with the same key. Expect its status, no new motion.   |
| Expired command not executed        | Send with `expiresAt` in the past. Expect `rejected` and no motion.                                              |
| Unauthorised user cannot command    | Covered by the server. Confirm the adapter only acts on gateway messages, with no side channel.                  |
| Network cut mid-mission             | Pull the link. The device reaches its declared safe state. The server shows STALE and then unknown or timed out. |
| Reconnect does not resume or replay | Restore the link. The device stays stopped, reports `failsafe_stop`, and nothing sent during the cut runs.       |
| Stop shows pending, then confirmed  | `succeeded` only after measured speed is 0. Test the physical E-stop per the device plan.                        |
| Position accuracy is honest         | Compare reported `accuracyM` with surveyed points.                                                               |
| Units and datum                     | Positions are in site metres after your transform. Altitude uses the site datum.                                 |

A tested example is in [`examples/custom-adapter.ts`](../examples/custom-adapter.ts), exercised by
`apps/gateway/test/example.test.ts`.
