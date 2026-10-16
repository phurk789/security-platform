# Field Responder app (`@13store/field`)

Mobile web app for field staff (PRD F14, UX/UI S07). Served by the API server at `/field/`.

- **Tasks**: list of tasks assigned to you. Each one moves through Accept → Arrived on scene → Report result (note + photos).
- **Offline first**: every change goes into an outbox stored on the phone (`localStorage`). Each item gets its idempotency key once, when it is queued, so a resend after a dropped connection never creates a second report or photo. The outbox retries when the phone comes back online, every 10 s, and on "Sync now". A 409 on a resend counts as done if the server already shows the task past that step. Other 4xx responses mark the item "Not sent" with the server's message, and you can retry or discard it. Last-loaded tasks are cached so the list still opens offline.
- **Photos** are scaled down to at most 1600 px (JPEG) before upload.
- **Live updates** come over `/api/v1/ws`. The dot at the top shows Live / Connecting / Offline.
- Thai (default) and English. The environment label (SIMULATION / MIXED DEMO / LIVE) comes from `/api/v1/meta`.
- No device control. Only users with the Field Responder role can sign in.

```bash
npm run dev -w @13store/field     # http://localhost:5174/field/ (proxies /api to :8080)
npm run build -w @13store/field   # → apps/field/dist, served by the server at /field/
```

Demo login: `kitti` / `demo1234` (task on INC-023).
