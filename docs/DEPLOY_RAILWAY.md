# Deploy the platform server on Railway

Runs the real platform (server, console, field app, API, gateway endpoint) as one Railway service
at `https://twin.uavsystem.cloud`. The Vercel site stays as the offline demo.

Railway reads `railway.json` (Dockerfile build, health check on `/api/v1/health`).

## 1. Create the service

1. railway.com → **New Project** → **Deploy from GitHub repo** → `inutzinutz/thermalplatform`.
2. Service → **Settings → Source → Branch**: `claude/new-session-iwalin` (or the release branch).
3. Service → right-click → **Attach volume** → mount path **`/data`** (database, evidence, backups,
   keys). Without it every redeploy starts from an empty database.

## 2. Variables

Service → **Variables**:

| Variable                   | Value                                                          |
| -------------------------- | -------------------------------------------------------------- |
| `ENV_MODE`                 | `pilot`                                                        |
| `MEDIA_SECRET`             | a long random string (32+ characters)                          |
| `ADMIN_PASSWORD`           | the first admin password (change it after the first sign-in)   |
| `ALLOWED_ORIGINS`          | `https://twin.uavsystem.cloud`                                 |
| `RAILWAY_RUN_UID`          | `0` (the image runs as `node`; Railway volumes are root-owned) |
| `VITE_GOOGLE_MAPS_API_KEY` | optional: photorealistic site view (build-time)                |

`PORT` is set by Railway and read by the server. `TRUST_PROXY` defaults to on in pilot mode,
which is right behind Railway's proxy.

## 3. First deploy

Deploy. In **Deployments → logs**, the first run prints the **gateway key once**
(`gateway key: gw_…`). Copy it to a password manager: the edge PC needs it.

## 4. Domain

1. Service → **Settings → Networking → Custom Domain** → `twin.uavsystem.cloud`, target port as
   Railway shows (the server listens on `PORT`).
2. Railway shows a **CNAME** target (and sometimes a TXT record). `uavsystem.cloud` uses Vercel
   DNS: Vercel → Domains → `uavsystem.cloud` → DNS Records → add `CNAME twin <target>` (and the TXT
   record if asked).
3. Wait for Railway to show the certificate as issued, then open `https://twin.uavsystem.cloud`
   and sign in as `admin`.

If the Google Maps key is restricted by referrer, add `https://twin.uavsystem.cloud/*`.

## 5. Next

- Administration → register the real devices; issue more gateway keys if needed.
- Edge PC: `deploy/edge/site.json` with `"serverUrl": "wss://twin.uavsystem.cloud"` and the gateway
  key (see HARDWARE_SIYI.md).
- Backups: the server writes scheduled backups into `/data`; also download one from
  Administration regularly, since a Railway volume is a single copy.
