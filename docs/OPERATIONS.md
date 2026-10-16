# Operations

## Run

| Goal | Command |
|---|---|
| Demo stack in containers | `docker compose up --build` → http://localhost:8080 |
| Demo from source | `npm ci && npm run build && npm start` → http://localhost:8080 |
| Develop | `npm run dev` (server, embedded gateway) and `npm run dev -w @13store/web` (http://localhost:5173, proxies `/api`) |
| Separate edge gateway | `SERVER_URL=ws://server:8080 GATEWAY_KEY=… npm start -w @13store/gateway` |
| Offline demo file | `npm run build:demo` → `apps/web/dist-single/index.html` |

The server serves the command centre at `/`, the field app at `/field/`, the API at `/api/v1`
and the API description at `/api/v1/openapi.json`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ENV_MODE` | `demo` | `demo` or `pilot` (see ARCHITECTURE.md → Environments) |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | Database, evidence files and backups |
| `DB_FILE` | `$DATA_DIR/platform.sqlite` | Database path |
| `MEDIA_SECRET` | demo value | **Required in pilot.** Signs media URLs |
| `ADMIN_PASSWORD` | random, printed once | Pilot first-run admin password |
| `SEED_PASSWORD` | `demo1234` | Password for seeded demo users (demo only) |
| `SESSION_TTL_MS` | 12 h | Session lifetime |
| `EMBED_GATEWAY` | `1` in demo, `0` in pilot | Run the simulated gateway inside the server |
| `GATEWAY_KEY` | demo key | Key the embedded gateway uses |
| `LOG` | `0` | `1` enables request logging |

## First run

- **Demo:** seeds the Civic Center scenario, six demo users, simulated devices, a demo gateway
  key (`gw_demo_local_key`), a demo alert key (`sk_demo_alerts_local`) and the developer sandbox
  (`dev` / `devop`, keys `sk_sandbox_demo_key`, `gw_sandbox_demo_key`). These fixed values exist
  only in the demo environment.
- **Pilot:** creates one organisation, one site record, the `admin` user and a random gateway key,
  printed once to the log. The admin then creates users, registers devices and issues keys in
  Administration.

## Pilot checklist

1. Put a TLS reverse proxy (nginx, Caddy, a cloud load balancer) in front; forward WebSockets
   for `/api/v1/ws` and `/api/v1/gateway`.
2. Set `ENV_MODE=pilot`, a long random `MEDIA_SECRET`, and `ADMIN_PASSWORD`.
3. Keep `DATA_DIR` on persistent, backed-up storage.
4. Replace the placeholder site geometry with the surveyed site model and coordinate transform.
5. Register real devices; connect the edge gateway with a pilot gateway key; check each adapter's
   declaration in Devices. A device stays without commands until its adapter declares them.
6. Run the acceptance checks against the real devices (see TRACEABILITY.md §11), including the
   physical emergency stop and link-loss behaviour, before any public-area operation.
7. Do a restore test (below) and record it.

## Backup and restore

- **Create:** Administration → Back up now, or `POST /api/v1/admin/backups`. A backup holds a
  consistent database copy (`VACUUM INTO`), the evidence files and a manifest with SHA-256 for
  every file, row counts and the audit chain heads.
- **Verify:** Administration → Verify, or `POST /api/v1/admin/backups/<id>/verify`. Checks every
  file checksum, row counts and that the audit chains still verify.
- **Restore** (server stopped):

  ```bash
  npm run restore -w @13store/server              # list backups
  npm run restore -w @13store/server -- <id>      # verify, then restore into DATA_DIR
  npm run restore -w @13store/server -- <id> /tmp/restore-test   # restore elsewhere to test
  ```

  In the container: `docker compose run --rm server node apps/server/dist/cli/restore.js <id>`.
- Copy `DATA_DIR/backups/` off the host on a schedule. Backups are not encrypted by the
  platform; use encrypted storage.

## Audit

- `GET /api/v1/audit/verify` (Administration → Audit log integrity) recomputes the chain.
  Any edit or deletion breaks it at that entry.
- The audit log is never cleared, including by demo reset.
- For stronger guarantees, ship audit entries to write-once storage (object lock) — the chain
  head can be anchored there periodically.

## Retention and deletion

Evidence carries a `retentionClass` (default `standard`). The platform does not delete anything
automatically: retention periods must come from the customer's policy reviewed by legal (PRD §8).
Deletion will be added as an audited admin action once those rules exist.

## Security notes

- Passwords are hashed with scrypt; repeated failures lock a username for one minute.
- Session tokens and API keys are stored only as SHA-256 hashes. Secrets are shown once.
- Changing a user's role, password or disabling them ends their sessions.
- Responses carry `nosniff`, `no-referrer` and `X-Frame-Options: DENY`. SVG evidence is served
  with a restrictive CSP.
- Uploads are limited to 8 MB and to JPEG, PNG, WebP, SVG, PDF, MP4 and plain text.

## Demo operations (booth)

- Before each run: Demo controls → Reset demo dataset (also resets the simulated devices).
- If the network or a device fails mid-demo, switch to the offline demo file and say so
  (UXUI §9). Never present recorded video as live.
