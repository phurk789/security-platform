# Office test server 192.168.20.13 — demo deployment

thermalplatform runs here in **demo mode** (simulated devices, demo accounts, password `demo1234`)
at **http://192.168.20.13:8090**.

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
  compose.yaml          this folder's compose.yaml (image only, never builds or pulls)
  .env                  THERMAL_TAG=<git short sha> — which image compose runs
  .docker\config.json   {}  — empty Docker config for builds over SSH (see below)
  src-<tag>\            the code of that commit (one fresh folder per deploy)
```

Data (SQLite, evidence, backups, generated keys) lives in the Docker volume `thermal_thermal-data`.

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

On the server (SSH or RDP, PowerShell):

```powershell
$tag = '<tag>'
tar -xzf C:\Server\thermal\thermal-src-$tag.tar.gz -C C:\Server\thermal\src-$tag
$env:DOCKER_CONFIG = 'C:\Server\thermal\.docker'
$env:DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine'
$env:DOCKER_BUILDKIT = '0'
cd C:\Server\thermal\src-$tag
docker build -t thermal-platform:$tag .
Set-Content -Encoding ascii C:\Server\thermal\.env "THERMAL_TAG=$tag"
docker compose -f C:\Server\thermal\compose.yaml up -d
```

Roll back: put the previous tag back in `.env` and run the same `up -d`.

## Check and stop

```powershell
docker compose -f C:\Server\thermal\compose.yaml ps
docker compose -f C:\Server\thermal\compose.yaml logs --tail 50 server
curl http://192.168.20.13:8090/api/v1/health
docker compose -f C:\Server\thermal\compose.yaml down        # stop (keeps the data volume)
```

## Known limits

- The simulated gateway runs inside the server (`EMBED_GATEWAY=1`). In image `406d410` the
  standalone gateway crashes on start (`Dynamic require of "events" is not supported`) because
  the `apps/gateway` esbuild command lacked the `createRequire` banner the server build has. The
  build now has it; use an image built after that fix before running a separate gateway here or
  on an edge PC.
- Plain HTTP on the LAN: sign-in and the console work; Web Push in the field app and this
  computer's camera need HTTPS.
- Docker Desktop starts only when `phurk` signs in, and the server has no auto sign-in. After a
  reboot nothing runs until someone signs in (affects every stack on this machine).
