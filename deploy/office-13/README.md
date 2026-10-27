# Office test server 192.168.20.13

thermalplatform runs here at **http://192.168.20.13:8090**. Since 2026-10-26 it runs in **pilot
mode** for real devices (first vehicle: UGV-01, see [`deploy/edge/FIRST_CONNECTION_TH.md`](../edge/FIRST_CONNECTION_TH.md)).
The earlier demo (simulated devices, demo accounts) is kept in its own volume and can come back.

The server is Windows 11 + Docker Desktop and also hosts other stacks. Keep them apart:

| Stack                | Port     | Compose project | Folder                        |
| -------------------- | -------- | --------------- | ----------------------------- |
| VMS (auto-deployed)  | 8080     | `mock-vms`      | `C:\actions-runner\mock-vms\` |
| LCOT                 | 80       | `lcot`          | `C:\lcot\`                    |
| **thermalplatform**  | **8090** | **`thermal`**   | **`C:\Server\thermal\`**      |

Never publish 8080 or 80 from this project, and never run compose commands against the other
projects' files.

## Layout on the server

```
C:\Server\thermal\
  compose.yaml          this folder's compose.yaml (server: our image, never built or pulled by compose;
                        media: bluenviron/mediamtx:1.9.3, pulled once)
  mediamtx.yml          this folder's mediamtx.yml (the platform's media server, ports 18554/18889/18189)
  .env                  THERMAL_TAG=<git short sha>, THERMAL_DATA_VOLUME=<volume>
  .env.server           ENV_MODE, MEDIA_SECRET, TRUST_PROXY, CSP_CONNECT_SRC, MEDIA_INGEST_URL,
                        MEDIA_PUBLIC_URL (made on the server, not in git)
  .env.server.demo      ENV_MODE=demo, ready for a switch back
  .docker\config.json   {}  — empty Docker config for builds over SSH (see below)
  src-<tag>\            the code of that commit (one fresh folder per deploy)
  backups\              volume copies taken before each switch
```

| Volume                 | Environment | Notes                                                        |
| ---------------------- | ----------- | ------------------------------------------------------------ |
| `thermal_pilot-data`   | pilot       | real devices; only the `admin` account until users are added |
| `thermal_thermal-data` | demo        | simulated devices and demo accounts (`demo1234`)             |

**Pilot first run** printed the `admin` password and the gateway key once, in the container log.
Read them with `docker logs thermal-server-1 2>&1 | Select-String "admin password|gateway key"`
and store them; the log is gone once the container is re-created, and there is no reset tool yet.

**Pilot settings in `.env.server`:** `TRUST_PROXY=0` (no proxy in front), and
`CSP_CONNECT_SRC=https: wss: http:` so the console may fetch video from an edge's own MediaMTX
(pull mode) over plain http on the LAN. Once every edge pushes into the media service (below),
drop `http:`: the media service's address is added to the policy automatically.

## Pushed video (media service)

Edge gateways whose `site.json` says `"stream": { "rtsp": "…", "push": true }` push the camera into
the `media` service here; browsers watch from it. No edge needs a reachable address, and no
"Allowed video sources" entry is needed for it (the server's own media server is always allowed,
also in the console's Content-Security-Policy).

| Port (host = container) | What |
| --- | --- |
| 18554/tcp | RTSP: gateways publish (`pub:<token>`, a credential the server gives each gateway on connect) |
| 18889/tcp | WebRTC signalling (WHEP): browsers, with the console's 60-second token |
| 18189/udp, 18189/tcp | WebRTC media (TCP when UDP is blocked) |

LCOT's MediaMTX uses 8554/8889/8189; these do not clash. To switch it on (once):

```powershell
cd C:\Server\thermal
# copy mediamtx.yml and compose.yaml from deploy/office-13 of the deployed commit
Copy-Item src-$tag\deploy\office-13\mediamtx.yml, src-$tag\deploy\office-13\compose.yaml . -Force
Add-Content -Encoding ascii .env.server "MEDIA_INGEST_URL=rtsp://192.168.20.13:18554"
Add-Content -Encoding ascii .env.server "MEDIA_PUBLIC_URL=http://192.168.20.13:18889"
docker pull bluenviron/mediamtx:1.9.3
docker compose up -d
docker compose logs --tail 20 media     # "listener opened on :18554 (TCP)" and ":18889"
```

Every publish and every viewer is checked with the server (`POST /api/v1/media/auth`): a gateway
may publish only its own device's path (`ugv-01` for `UGV-01`) while it is connected. To switch
pushed video off, remove the two `MEDIA_*` lines and run `docker compose up -d` (gateways then
log "the server gave no video publish address" and video stays off until they use pull mode).

## Deploy a new version

Builds run **on the server**. Over SSH, Docker Desktop's credential helper fails ("A specified
logon session does not exist"), so builds use an empty `DOCKER_CONFIG` and the classic builder,
the same workaround LCOT uses. The base image `node:22-bookworm-slim` is already on the server.

From this repo on a workstation (PowerShell, key `~/.ssh/lcot`, user `phurk`):

```powershell
$tag = git rev-parse --short HEAD
git archive --format=tar.gz -o "thermal-src-$tag.tar.gz" HEAD
ssh -i ~/.ssh/lcot phurk@192.168.20.13 "powershell -Command New-Item -ItemType Directory -Force C:\Server\thermal\src-$tag"
scp -i ~/.ssh/lcot "thermal-src-$tag.tar.gz" phurk@192.168.20.13:/C:/Server/thermal/
```

On the server (SSH or RDP, PowerShell). Back up the volume first (stop the server so SQLite is
not being written):

```powershell
$tag = '<tag>'
tar -xzf C:\Server\thermal\thermal-src-$tag.tar.gz -C C:\Server\thermal\src-$tag
$env:DOCKER_CONFIG = 'C:\Server\thermal\.docker'
$env:DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine'
$env:DOCKER_BUILDKIT = '0'
cd C:\Server\thermal\src-$tag
docker build -t thermal-platform:$tag .
cd C:\Server\thermal
docker compose stop server
$vol = ((Get-Content .env) -match '^THERMAL_DATA_VOLUME=') -replace '^THERMAL_DATA_VOLUME=', ''
docker run --rm --user root -v "${vol}:/data:ro" -v C:\Server\thermal\backups:/backup --entrypoint sh thermal-platform:$tag -c "tar czf /backup/$vol-$(Get-Date -Format yyyyMMdd-HHmmss).tgz -C /data ."
(Get-Content .env) -replace '^THERMAL_TAG=.*', "THERMAL_TAG=$tag" | Set-Content -Encoding ascii .env
docker compose up -d
```

Roll back: put the previous tag back in `.env` and run `docker compose up -d`.

## Switch between pilot and demo

Each keeps its own volume, so nothing is lost either way. Re-creating the container drops its log.

```powershell
cd C:\Server\thermal
# to demo
Copy-Item .env.server .env.server.pilot; Copy-Item .env.server.demo .env.server
(Get-Content .env) -replace 'thermal_pilot-data', 'thermal_thermal-data' | Set-Content -Encoding ascii .env
docker compose up -d
# back to pilot
Copy-Item .env.server.pilot .env.server
(Get-Content .env) -replace 'thermal_thermal-data', 'thermal_pilot-data' | Set-Content -Encoding ascii .env
docker compose up -d
```

## Check and stop

```powershell
docker compose -f C:\Server\thermal\compose.yaml ps
docker compose -f C:\Server\thermal\compose.yaml logs --tail 50 server
curl http://192.168.20.13:8090/api/v1/meta
docker compose -f C:\Server\thermal\compose.yaml down        # stop (keeps the data volume)
```

## Known limits

- Edge media origins are set in Administration → Allowed video sources (or with
  `deploy/edge/Set-EdgeOrigin.ps1`). Promoting a device from SHADOW to LIVE_MANUAL has no screen
  yet: it is an API call for a supervisor after the hardware checklist in `docs/HARDWARE_SIYI.md`.
- Plain HTTP on the LAN: sign-in, the console and WHEP video work; Web Push in the field app and
  this computer's camera need HTTPS. A pilot beyond the office needs TLS (`docs/SECURITY.md`).
- Docker Desktop starts only when `phurk` signs in, and the server has no auto sign-in. After a
  reboot nothing runs until someone signs in (affects every stack on this machine).
