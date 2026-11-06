# Vision: AI detection on camera pictures

Where detections come from when the camera has no analytics of its own, or when the customer
wants one model and one set of rules across every camera brand. The edge gateway watches each
camera's pictures, runs detectors on them, applies image zones and tracking, and reports
detections to the platform exactly like a camera's built-in analytics would
(`POST /detections` rules, incidents, evidence, notifications all apply unchanged; see
`VIDEO.md → Detections and rules`).

## What runs where

```
camera ──RTSP/snapshot/MJPEG──▶ edge gateway: frames → detectors → zones → tracking → rate control
                                       │                                   │
                                       │ detection + JPEG crop             │ health every 15 s
                                       ▼                                   ▼
                                 platform: rules → incident / merge / log → evidence, console overlay
```

Everything runs on the edge PC next to the cameras; only detections, small JPEG crops and health
figures cross to the platform. No video leaves the site for analytics.

## Frame sources

| Source              | Config                                                                                                                               | Use                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Snapshot URI        | `vision.frames: "snapshot"` on an ONVIF camera, or `source: { kind: "snapshot", url, intervalMs, auth }`                             | Every camera; 0.2–2 fps; cheapest; Basic/Digest auth                                                             |
| RTSP through ffmpeg | `vision.frames: "rtsp"` on an ONVIF camera (uses its stream URI and credentials), or `source: { kind: "ffmpeg", input, fps, width }` | Real frame rates (1–10 fps); any input ffmpeg opens (RTSP, RTMP, SRT, file, V4L2); needs `ffmpeg` on the edge PC |
| MJPEG               | `source: { kind: "mjpeg", url, auth }`                                                                                               | Older or cheap cameras, MediaMTX MJPEG paths                                                                     |
| Folder              | `source: { kind: "folder", dir, intervalMs }`                                                                                        | Demos, tests, replaying a recorded sequence                                                                      |
| Follow a vehicle    | `source: { kind: "follow", fps, width }` with `"follows": "<vehicle id>"` on the device                                              | A vehicle's camera, read from the site media server with a pass the server grants (see _Camera AI on a vehicle_) |

A `type: "vision"` device is a camera the platform knows only through its pictures (an NVR
channel, a vendor's RTSP URL); it appears as a CCTV device with the `analytics` capability and no
commands. On an ONVIF camera, `vision` runs inside the camera adapter and the same device shows
PTZ, snapshots, events **and** edge analytics.

## Detectors

| Detector    | Needs                                                         | Reports                                                            | Config                                                                                                                                                        |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **motion**  | nothing (background subtraction)                              | `motion` boxes; in a protected zone → `intrusion`                  | `width` (160), `threshold` (28 grey levels), `minArea` (0.4 %), `maxArea` (60 %, whole-scene changes are ignored), `learnRate`                                |
| **thermal** | a thermal camera streaming with a fixed temperature span      | `thermal_hotspot` with `temperatureC` (peak in the region)         | `minC`, `maxC` (what grey 0 and 255 mean), `thresholdC` (60), `minArea`                                                                                       |
| **onnx**    | `onnxruntime-node` installed on the edge PC and a model file  | model classes → `person`, `vehicle`, `fire`, `smoke`… (`classMap`) | `model` (path), `inputSize` (640), `classes` (COCO-80 default), `include`, `classMap`, `minConfidence` (0.35), `iouThreshold`, `providers` (`["cuda","cpu"]`) |
| **http**    | an AI service that answers the contract below (e.g. a Jetson) | the service's labels → platform types (same `classMap` defaults)   | `url`, `headers` (e.g. `{"authorization": "Bearer …"}`), `include`, `classMap`, `minConfidence` (0.35), `timeoutMs` (1500), `retryMs` (2000)                  |

**http contract.** The gateway posts each frame as one JPEG (`content-type: image/jpeg`; the
camera's own JPEG when it sent one, so no re-encoding) and expects
`{"model": "...", "ms": 6.4, "detections": [{"label": "person", "confidence": 0.91, "box": [x, y, w, h]}]}`
with boxes as fractions of the frame from the top-left corner. A refusal or a timeout pauses the
detector for `retryMs` (frames are skipped, not queued) and shows on the device as an error; it
recovers by itself. `deploy/jetson/vision_server.py` implements the contract with Ultralytics
YOLO on TensorRT, or `--fake` (a walking figure, no model) to test the wiring.

Models: any YOLOv8 / YOLO11 export (`yolo export model=yolov8n.pt format=onnx`) or a YOLOv5
export; both output layouts are decoded, with letterbox pre-processing and per-class NMS. A
fire-and-smoke model with its own class list works through `classes` + `classMap`. The runtime is
not a dependency of the platform: `npm i onnxruntime-node` on the edge PC (CPU works at 1–3 fps
for yolov8n on a small industrial PC; CUDA or OpenVINO builds for more).

## Zones, tracking and rate control

- **Image zones** are polygons in frame coordinates (0–1): `protected` (a person, vehicle or
  motion inside becomes an `intrusion`), `ignore` (public road, trees), `count` (people at or
  above `crowdMin` raise a `crowd` with the count). A zone names the site `zone`, `place` and
  `pos` the detection is filed under, so the alert lands at the right spot on the twin.
- **Tracking**: people are tracked by box overlap; a track older than `loiterS` raises
  `loitering` once.
- **Persistence**: a detection type must be seen in `minFrames` consecutive frames (2 by default;
  thermal, crowd and loitering need one).
- **Cooldown**: one report per type and image zone every `cooldownS` (30 s); the platform's own
  rules then merge repeats into the open incident.
- **Evidence**: each report carries a JPEG crop (with margin, ≤ 640 px) that becomes a
  `snapshot` evidence item when the rules raise or merge an incident.

## In the console

- Live feeds show the boxes for 12 s after each detection: type, confidence, temperature or
  count, and the incident it raised (red) or that it was logged (blue).
- Device details → camera tab shows the analytics line: provider, model, detectors, fps,
  detection count, last error.
- Administration → Detection rules decide what happens to each type (raise, log, ignore) per
  organisation; the edge decides what it _saw_, the platform decides what it _means_.
- The booth's _Inject AI detection_ buttons draw the same overlay offline.
- **Live boxes on a vehicle's cockpit**: a pipeline also streams what it sees in the latest frame
  (≤ 5 times a second, people keep their number while followed, one empty list when the last
  one leaves). The server checks the boxes, thins them to 10 a second and passes them only to
  consoles allowed to see video; they are never stored (detections are the record). The
  Command Centre's cockpit draws them over the video and shows an **AI** chip in the HUD:
  _intruders n_ (red), _people in view n_ (amber), _watching_ with fps, _no pictures_, or
  _AI model not answering_ (an http detector's service is down; the error is the tooltip).

## Camera AI on a vehicle

A vehicle's camera can be watched by its own camera AI: a `vision` device with
`"follows": "<vehicle id>"`. It reads the vehicle's video from the site media server (the stream
the vehicle already pushes), so nothing changes on the vehicle, and it works indoors: it needs
pictures, not GPS. Detections are filed at the vehicle's position when it has a fix, else at the
camera AI's configured `pos`.

The intended home is an **NVIDIA Jetson Orin** on the LAN next to the platform server: the
gateway on the Jetson runs the camera AI and `deploy/jetson/vision_server.py` runs YOLO on the
GPU behind the http detector. Step-by-step guide (Thai): `deploy/jetson/README_TH.md`; the
gateway config is `deploy/jetson/site.camera-ai.example.json`:

```json
{
  "type": "vision",
  "deviceId": "UGV-01-AI",
  "model": "Camera AI · Jetson Orin (YOLOv8s, TensorRT FP16)",
  "pos": { "x": 0, "y": 0 },
  "follows": "UGV-01",
  "vision": {
    "source": { "kind": "follow", "fps": 8, "width": 960 },
    "detectors": { "http": { "url": "http://127.0.0.1:8601/detect", "timeoutMs": 1000 } },
    "zones": [{ "id": "show", "name": "Show area", "kind": "protected", "poly": [[0, 0], [1, 0], [1, 1], [0, 1]] }],
    "minConfidence": 0.5,
    "minFrames": 2,
    "cooldownS": 60
  }
}
```

**Read pass.** With `source: { kind: "follow" }` the config holds no video address or password.
When the gateway connects, the server checks that the camera AI is registered, accepted and
follows a vehicle, and puts a read pass in the welcome: an RTSP URL for that vehicle's path on
the media server, signed for this organisation, camera AI and gateway, with an expiry. The media
server's auth hook accepts it only for reads of that one path, and only while that gateway is
connected and still holds the camera AI. The gateway starts ffmpeg on the pass (default 5 fps,
640 px wide) and switches to the renewed pass on each reconnect; until the first pass arrives it
logs _waiting for the server to grant the video of …_. Needs the server's media settings
(`MEDIA_INGEST_URL`, `MEDIA_PUBLIC_URL`, `MEDIA_SECRET`), the same ones pushed video uses.

Other placements work too: the `onnx` detector on a laptop or the platform server (CPU, 1–3 fps
for yolov8n), or an explicit `ffmpeg` source with the media server's address. Register
`UGV-01-AI` (kind CCTV) under Administration first and give its gateway a key. A protected zone
over the whole frame turns every person into an intrusion (the default rule raises an incident at
≥ 60 %).

## Configuration

`apps/gateway/config/vision-site.example.json` shows an ONVIF PTZ camera with motion + YOLO on
its RTSP stream, a thermal camera on snapshots, an NVR channel through ffmpeg with a crowd zone,
and an MJPEG camera with motion only. Tuning order: pick the frame rate the PC sustains (watch
`fps` in the console), set `ignore` zones for public areas, raise `minConfidence`/`minFrames`
until false alarms stop, then shorten `cooldownS` if repeats are missed.

## Status

| Part                                                                                 | Status                                                                                                                                      | Tests                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Frame sources (snapshot with Basic/Digest, MJPEG, ffmpeg, folder)                    | Done — verified against fake servers and ffmpeg's test source                                                                               | `apps/gateway/test/vision.test.ts`                                                                     |
| Motion and thermal detectors                                                         | Done                                                                                                                                        | `vision.test.ts`                                                                                       |
| ONNX/YOLO detector (decode, NMS, class mapping, runtime loading)                     | Done — verified with a fake runtime; run with a real model on the edge PC during the pilot                                                  | `vision.test.ts`                                                                                       |
| Zones, tracking, loitering, crowd, persistence, cooldown, evidence crops             | Done                                                                                                                                        | `vision.test.ts`                                                                                       |
| Platform: analytics health on the device, detection events and overlay               | Done                                                                                                                                        | `apps/server/test/vision.test.ts`                                                                      |
| Live boxes (pipeline → gateway → server → cockpit), camera AI that follows a vehicle | Done — end to end on a local server with the motion detector; a real model and vehicle video still to try                                   | `vision.test.ts`, `apps/server/test/vision-tracks.test.ts`, `apps/web/src/domain/visionTracks.test.ts` |
| http detector and the Jetson AI service (`deploy/jetson/`)                           | Done — end to end locally with `vision_server.py --fake`, including the service going down and back; TensorRT on a real Jetson still to try | `vision.test.ts`                                                                                       |
| Read pass for a follow source (welcome → media auth → ffmpeg)                        | Done in tests; not yet run against the real media server and a vehicle's stream                                                             | `vision-tracks.test.ts`, `vision.test.ts`                                                              |
