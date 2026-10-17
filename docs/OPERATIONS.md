# Operations

## Run

| Goal                     | Command                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo stack in containers | `docker compose up --build` → http://localhost:8080                                                                                                                                                                    |
| Demo from source         | `npm ci && npm run build && npm start` → http://localhost:8080                                                                                                                                                         |
| Develop                  | `npm run dev` (server, embedded gateway) and `npm run dev -w @13store/web` (http://localhost:5173, proxies `/api`)                                                                                                     |
| Separate edge gateway    | `SERVER_URL=ws://server:8080 GATEWAY_KEY=… npm start -w @13store/gateway`                                                                                                                                              |
| Offline demo file        | `npm run build:demo` → `apps/web/dist-single/index.html`                                                                                                                                                               |
| Vercel (static demo)     | Push to the connected repo; `vercel.json` runs `npm run build:vercel`. Vercel serves the offline demo only — the server needs a host with long-running processes and a disk (VM, Docker host, Railway, Fly.io, Render) |

The server serves the command centre at `/`, the field app at `/field/`, the API at `/api/v1`
and the API description at `/api/v1/openapi.json`.

## Configuration

| Variable                                                                                           | Default                                      | Meaning                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV_MODE`                                                                                         | `demo`                                       | `demo` or `pilot` (see ARCHITECTURE.md → Environments)                                                                                         |
| `PORT`, `HOST`                                                                                     | `8080`, `0.0.0.0`                            | Listen address                                                                                                                                 |
| `DATA_DIR`                                                                                         | `./data`                                     | Database, evidence files and backups                                                                                                           |
| `DB_FILE`                                                                                          | `$DATA_DIR/platform.sqlite`                  | Database path                                                                                                                                  |
| `MEDIA_SECRET`                                                                                     | demo value                                   | **Required in pilot.** Signs media URLs                                                                                                        |
| `ADMIN_PASSWORD`                                                                                   | random, printed once                         | Pilot first-run admin password                                                                                                                 |
| `SEED_PASSWORD`                                                                                    | `demo1234`                                   | Password for seeded demo users (demo only)                                                                                                     |
| `SESSION_TTL_MS`                                                                                   | 12 h                                         | Session lifetime                                                                                                                               |
| `EMBED_GATEWAY`                                                                                    | `1` in demo, `0` in pilot                    | Run the simulated gateway inside the server                                                                                                    |
| `GATEWAY_KEY`                                                                                      | demo key                                     | Key the embedded gateway uses                                                                                                                  |
| `LOG`                                                                                              | `0`                                          | `1` enables request logging                                                                                                                    |
| `LICENSE_FILE`                                                                                     | none                                         | Signed license JSON (see **License**). Without it a pilot runs as an evaluation (1 site, 10 devices, 5 users)                                  |
| `LICENSE_PUBLIC_KEY`                                                                               | built-in                                     | Override the Ed25519 public key that license files are verified against (PEM, `\n` escaped)                                                    |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`                         | none                                         | Enable single sign-on (see **Single sign-on**)                                                                                                 |
| `OIDC_NAME`, `OIDC_ROLE_CLAIM`, `OIDC_ROLE_MAP`, `OIDC_DEFAULT_ROLE`, `OIDC_ORG`, `OIDC_SYNC_ROLE` | `SSO`, `groups`, `{}`, none, `org-demo`, `1` | Button label, claim holding groups, group→role map (JSON), fallback role, organisation for provisioned users, keep roles in sync at each login |
| `METRICS_TOKEN`                                                                                    | none                                         | Bearer token Prometheus uses to scrape `/api/v1/metrics` (admins can also read it with their session)                                          |
| `BACKUP_INTERVAL_H`                                                                                | `24` in pilot, `0` in demo                   | Scheduled backup interval in hours; `0` disables                                                                                               |
| `BACKUP_KEEP`                                                                                      | `14`                                         | Scheduled backups kept before the oldest are pruned                                                                                            |
| `PURGE_INTERVAL_MS`                                                                                | 1 h                                          | How often the retention policy is applied                                                                                                      |

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

## License

Pilot and production servers run under a signed license file. A license is a JSON document
signed with Ed25519; the server verifies the signature against the built-in 13 STORE public key
(or `LICENSE_PUBLIC_KEY`) and refuses files issued for a different organisation.

```bash
npm run license -w @13store/server -- keygen                       # once, at 13 STORE: prints private + public key PEM
npm run license -w @13store/server -- sign --key issuer.pem --org org-acme --customer "ACME Estates" \
    --days 365 --sites 3 --devices 40 --users 60 --features onvif,playbooks > acme.license.json
npm run license -w @13store/server -- verify --pub issuer.pub.pem acme.license.json
```

- **Limits** are enforced on sites, registered devices and active users: exceeding one returns
  `402 license` and writes an audit entry. Existing operations are never blocked.
- **Expiry:** 30 days before expiry the console shows _Expiring soon_; after expiry a 14-day
  grace period keeps everything working, then adding devices or users is refused until a new
  file is installed. `GET /api/v1/license` and the Administration page show state, limits and
  usage; `ps_license_days_left` is exported as a metric.
- **Evaluation:** without `LICENSE_FILE` a pilot runs with 1 site, 10 devices and 5 users. The
  demo environment is unlimited.

## Single sign-on

Set the four `OIDC_*` variables to let people sign in with the customer's identity provider
(Azure AD / Entra ID, Keycloak, Okta, Google Workspace — any OpenID Connect provider with a
discovery document). The flow is Authorization Code with PKCE; ID tokens are verified against
the provider's JWKS (RS256/ES256) including issuer, audience, expiry and nonce. No extra library
is needed.

- Register the redirect URI `https://<host>/api/v1/auth/sso/callback` at the provider.
- Map the provider's groups to platform roles with `OIDC_ROLE_MAP`, e.g.
  `{"SecurityOps-Dispatch":"dispatcher","SecurityOps-Lead":"supervisor","IT-Admins":"admin"}`.
  A user whose groups match nothing is refused unless `OIDC_DEFAULT_ROLE` is set.
- Accounts are provisioned at first login (counted against the license), linked to an existing
  local account with the same username when one exists, and have no local password. Disabling
  the account in Administration blocks SSO logins too; with `OIDC_SYNC_ROLE=1` a role change at
  the provider is applied at the next login and audited (`auth.sso_role_sync`).
- Local accounts keep working alongside SSO, which is how break-glass administrators sign in if
  the provider is down.

## Monitoring

- `GET /api/v1/health` is liveness; `GET /api/v1/ready` returns 503 until the database answers,
  the gateway channel is up and the license is not expired.
- `GET /api/v1/metrics` is Prometheus text (bearer `METRICS_TOKEN`, or an admin session):
  request counts and latency histogram per route, devices by freshness, gateways and console
  clients connected, incident / command / audit event counters, license days left, uptime.
  Suggested alerts: `ps_devices{freshness="offline"} > 0 for 5m`, `ps_gateways_connected == 0`,
  `ps_license_days_left < 14`, `rate(ps_http_requests_total{status=~"5.."}[5m]) > 0`.
- Scheduled backups run every `BACKUP_INTERVAL_H` hours into `DATA_DIR/backups`, keep the newest
  `BACKUP_KEEP` and are audited (`admin.backup_create` by _Backup scheduler_).

## Notifications and SLA

- Channels are configured in Administration → **Notification channels** (or `PATCH /admin/settings`).
  Webhook: give the receiver the shared secret and have it verify `X-PST-Signature`. LINE: a LINE
  Official Account channel access token and the group id (add the bot to the group). SMS: the
  gateway's HTTP URL with `{to}` / `{text}` placeholders. Use **Test** after saving; every delivery
  (and every retry) is in the log and in `ps_notifications_total{kind,status}`. Outbound traffic goes
  to the channel endpoints only; allow them in the server's egress policy.
- SLA limits per incident type are the playbooks in the same settings. The server checks open
  incidents every 10 s and raises a breach once; suggested alert: `increase(ps_sla_breaches_total[1h]) > 3`.
- The monthly report is Reports → Operations KPIs → **Export period report** (or
  `GET /kpi/report?from&to&download=1`). See COMMAND_CENTRE.md.

## Video recordings

Recordings live on the edge PC (`deploy/edge/mediamtx.yml`: `record: yes`, `playback: yes`,
`recordDeleteAfter`). Size the `recordings` volume for cameras × bitrate × retention (a 4 Mbit/s
camera is ~43 GB per day). The platform never copies recordings except the clips an operator
saves to an incident, which become evidence under the evidence retention policy. Each camera's
`stream.playback` in `site.json` names the playback server (`https://edge.example.com:9996`); put
it behind the same TLS proxy as the WHEP endpoints. See VIDEO.md.

## Retention and privacy (PDPA)

Each organisation has a retention policy, set in Administration → Data retention or with
`PATCH /api/v1/admin/settings`:

| Setting              | Default  | Removes                                                                                                        |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `telemetryDays`      | 90       | Device position/status samples older than N days                                                               |
| `closedIncidentDays` | 0 (keep) | Incidents closed more than N days ago, with their missions, commands, timeline, assignments and evidence files |
| `evidenceDays`       | 0 (keep) | Evidence files older than N days, whatever the incident state                                                  |

The policy runs every `PURGE_INTERVAL_MS` (default hourly) and on _Run now_. Every run that
removed something is audited (`retention.purge`). The audit log itself is never purged.

**Data-subject requests.** Administration → Privacy requests (or `GET /api/v1/admin/privacy?q=`)
lists every place a name or text appears in incident titles, places, outcomes, timeline entries,
evidence notes and field reports — the access-request answer. _Redact everywhere_
(`POST /api/v1/admin/privacy/erase`, step-up required) replaces the text with `[erased]` in all
of them and records the request reference in the audit log. Evidence media (photos, video) is
not altered; delete the evidence item or shorten `evidenceDays` for that.

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
