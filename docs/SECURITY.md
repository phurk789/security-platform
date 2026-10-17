# Security

How the platform protects a public-safety operation's data and keeps control of vehicles in
authorised hands. Written for a tender's security questionnaire and for the team that runs the
pilot. Status words: **Done** (in code, tested), **Pilot** (needs the customer's environment),
**Planned**.

## 1. Model

- **One server, one database per deployment** (on-premises or in a Thai-region cloud of the
  customer's choice). Edge gateways at each site connect _out_ to the server; nothing connects in
  to a site network.
- **Organisations and sites** scope every query. A user sees only the sites they are assigned to;
  an API key or gateway key is bound to one organisation. Cross-scope requests return 404, never
  data. Tested for API, media URLs, evidence files and WebSocket events.
- **Roles with least privilege**: dispatcher, supervisor, operator, field responder, auditor,
  administrator. An administrator manages the system and _cannot_ see incident data or command
  devices; an auditor reads everything and changes nothing. The permission matrix is one table in
  `packages/shared/src/policy.ts`, enforced on the server for every action and mirrored in the UI.
- **Separation of duties on vehicles**: the dispatcher prepares, the supervisor approves (with a
  fresh password: _step-up_), the operator accepts and holds the single control token. A route
  change after approval cancels the approval. Replay mode and stale telemetry block commands.

## 2. Identity and sessions

| Control                                                                                                                                      | Status | Detail                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| Local accounts, scrypt password hashes                                                                                                       | Done   | `apps/server/src/security.ts`                                            |
| Lockout after 5 failed attempts per user (1 min)                                                                                             | Done   | `LoginThrottle`                                                          |
| Rate limit on sign-in and step-up per client address                                                                                         | Done   | `RATE_LIMIT_AUTH_PER_MIN` (default 60) → `429` + `Retry-After`           |
| Session tokens: random 256-bit, stored hashed, TTL (`SESSION_TTL_MS`, 12 h), revoked on role or password change                              | Done   | `accounts.ts`                                                            |
| Step-up (re-enter password) for approvals, handover, exports, user/key/backup administration, privacy erasure, patrol schedules, site anchor | Done   | `STEP_UP_ACTIONS`, 5-minute window                                       |
| Single sign-on (OpenID Connect) with group→role mapping, role sync at every sign-in                                                          | Done   | Azure AD / Keycloak / Google tested against a fake IdP; MFA is the IdP's |
| API keys for integrations and gateways, shown once, stored hashed, revocable                                                                 | Done   | Administration → API keys                                                |
| Per-environment credentials (developer sandbox is a separate organisation)                                                                   | Done   | `security.test.ts`                                                       |

## 3. Transport and browser

- TLS is terminated by the customer's reverse proxy (nginx / Traefik / cloud LB); the server
  trusts `X-Forwarded-*` from it. `HSTS=1` (default in pilot) adds `Strict-Transport-Security`.
- Response headers on every answer: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Resource-Policy`.
- **Content-Security-Policy** on the hosted console and field app: scripts only from the server's
  origin (the build has no inline scripts), video and WebSockets to the server and the configured
  media servers (`CSP_CONNECT_SRC`), `frame-ancestors 'none'`, `object-src 'none'`. SVG evidence is
  served with its own restrictive policy.
- Console WebSocket: bearer-token authenticated within 5 s of connecting, re-validated every
  30 s, closed when the session ends; `ALLOWED_ORIGINS` rejects browsers from other origins.
- Media: WebRTC (WHEP) streams need a signed, short-lived media session from the platform; the
  media server verifies it. Playback links expire after 60 s.
- Uploads: 8 MB, JPEG / PNG / WebP / SVG / PDF / MP4 / text only, served with `nosniff`.

## 4. Data at rest

| Control                                                                                                                                              | Status | Detail                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Secrets sealed with AES-256-GCM before they reach the database (webhook signing secrets, LINE tokens, SMS gateway headers)                           | Done   | `apps/server/src/secrets.ts`; key from `SECRETS_KEY` or `DATA_DIR/secrets.key` (0600) — keep it with the backups |
| Passwords, session tokens, API keys stored hashed only                                                                                               | Done   |                                                                                                                  |
| Evidence files with SHA-256 checksum, recorder, capture and receipt time                                                                             | Done   |                                                                                                                  |
| **Audit log as a hash chain** (each entry hashes the previous); `GET /audit/verify` and Administration show whether it is intact; it is never purged | Done   | `audit.ts`, verified in tests after restore                                                                      |
| Backups (scheduled + on demand) with manifest and checksums; restore verified in tests                                                               | Done   | `backup.ts`                                                                                                      |
| Disk encryption of the server and `DATA_DIR`                                                                                                         | Pilot  | Customer's host (LUKS / BitLocker / cloud volume encryption)                                                     |
| Retention policy per data class, PDPA access and erasure requests (`[erased]` tombstones, audited)                                                   | Done   | OPERATIONS.md → Retention and privacy                                                                            |

## 5. Commands and devices

- Every command carries an id, idempotency key, expiry and issuer; retries never execute twice
  (server and adapter ledger). Undelivered commands time out and are never re-sent after a
  reconnect.
- Only the commands an adapter declared are offered; the server re-checks capability, role,
  control holder, approval and geofences before sending.
- Physical emergency stop stays with the vehicle's own remote; the platform's stop is logged as
  _pending_ until the device confirms.
- Gateways authenticate with a key bound to one organisation and the sites it may serve; devices
  must be registered before a gateway may speak for them; the demo organisation refuses non-
  simulated adapters.

## 6. Monitoring and response

- `GET /ready` and Prometheus metrics (request counts and latency, device freshness, gateways
  and consoles connected, incidents, commands, audit events, SLA breaches, notifications, rate
  limits, license days left).
- Security-relevant audit actions: denied permissions, step-up, sign-in lockouts, key creation,
  backups, erasures, gateway anchor mismatches, exports and downloads.
- Outbound notifications (signed webhook, LINE, SMS) can carry security events to the SOC.
- Vulnerability handling: `npm audit` runs in CI (see §8); report issues to security@13store.co.th;
  fixes ship as patch releases with release notes.

## 7. Hardening checklist for a deployment

1. Run as an unprivileged user; `ENV_MODE=pilot`; set `MEDIA_SECRET`, `SECRETS_KEY`
   (or protect `secrets.key`), `SESSION_TTL_MS` to the shift length.
2. Reverse proxy with TLS 1.2+, modern ciphers, `HSTS=1`, `ALLOWED_ORIGINS=https://console…`,
   `CSP_CONNECT_SRC` listing the media servers. Rate limits: `RATE_LIMIT_AUTH_PER_MIN`,
   optionally `RATE_LIMIT_PER_MIN`.
3. Firewall: server reachable from the control room network and the field VPN only; gateways
   connect outbound; media servers behind the same proxy.
4. SSO with MFA enforced at the identity provider; local admin kept as break-glass with a
   long random password stored offline.
5. Backups to a second host, `BACKUP_KEEP` per policy, restore drill before go-live.
6. Retention periods from the customer's data-protection officer; PDPA notices at camera sites.
7. Time synchronised (NTP) on server, gateways and cameras — the audit chain and SLA timers
   depend on it.

## 8. Dependencies

`npm audit --omit=dev`: **no findings** (critical, high, moderate or low) at the time of writing.
The one advisory the tree used to carry (`xml2js` < 0.5 under `node-mavlink → mavlink-mappings-gen`,
a build-time MAVLink table generator) is closed by an `overrides` entry pinning `xml2js ^0.6.2`.
Direct runtime dependencies are Fastify, `ws`, `@fastify/static`, `@fastify/websocket`, React and
Three.js; no native modules besides Node's built-in SQLite. The audit runs with the test suite
before every release.

## 9. Standards mapping (summary)

| Requirement source                                                                                                                          | Where it is met                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Thai PDPA (B.E. 2562): lawful basis, retention, data-subject access and erasure                                                             | Retention policy, privacy requests, audit, erasure tombstones                |
| ISO/IEC 27001 Annex A: access control (A.5.15–18), logging (A.8.15), cryptography (A.8.24), backup (A.8.13), secure development (A.8.25–29) | Roles + step-up, hash-chained audit, TLS + sealed secrets, backups, CI tests |
| OWASP ASVS L2 (authentication, session, access control, input validation, HTTP security headers)                                            | §2, §3, server-side validation on every route, headers and CSP               |
| NCSA (Thailand) critical-infrastructure guidance: segmentation, logging, incident notification                                              | Outbound-only gateways, audit, SOC notifications                             |

Tests: `apps/server/test/security.test.ts`, `hardening.test.ts`, `acceptance.test.ts`.
