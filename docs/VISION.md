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

A `type: "vision"` device is a camera the platform knows only through its pictures (an NVR
channel, a vendor's RTSP URL); it appears as a CCTV device with the `analytics` capability and no
commands. On an ONVIF camera, `vision` runs inside the camera adapter and the same device shows
PTZ, snapshots, events **and** edge analytics.

## Detectors

| Detector    | Needs                                                        | Reports                                                            | Config                                                                                                                                                        |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **motion**  | nothing (background subtraction)                             | `motion` boxes; in a protected zone → `intrusion`                  | `width` (160), `threshold` (28 grey levels), `minArea` (0.4 %), `maxArea` (60 %, whole-scene changes are ignored), `learnRate`                                |
| **thermal** | a thermal camera streaming with a fixed temperature span     | `thermal_hotspot` with `temperatureC` (peak in the region)         | `minC`, `maxC` (what grey 0 and 255 mean), `thresholdC` (60), `minArea`                                                                                       |
| **onnx**    | `onnxruntime-node` installed on the edge PC and a model file | model classes → `person`, `vehicle`, `fire`, `smoke`… (`classMap`) | `model` (path), `inputSize` (640), `classes` (COCO-80 default), `include`, `classMap`, `minConfidence` (0.35), `iouThreshold`, `providers` (`["cuda","cpu"]`) |

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

## Configuration

`apps/gateway/config/vision-site.example.json` shows an ONVIF PTZ camera with motion + YOLO on
its RTSP stream, a thermal camera on snapshots, an NVR channel through ffmpeg with a crowd zone,
and an MJPEG camera with motion only. Tuning order: pick the frame rate the PC sustains (watch
`fps` in the console), set `ignore` zones for public areas, raise `minConfidence`/`minFrames`
until false alarms stop, then shorten `cooldownS` if repeats are missed.

## Status

| Part                                                                     | Status                                                                                     | Tests                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| Frame sources (snapshot with Basic/Digest, MJPEG, ffmpeg, folder)        | Done — verified against fake servers and ffmpeg's test source                              | `apps/gateway/test/vision.test.ts` |
| Motion and thermal detectors                                             | Done                                                                                       | `vision.test.ts`                   |
| ONNX/YOLO detector (decode, NMS, class mapping, runtime loading)         | Done — verified with a fake runtime; run with a real model on the edge PC during the pilot | `vision.test.ts`                   |
| Zones, tracking, loitering, crowd, persistence, cooldown, evidence crops | Done                                                                                       | `vision.test.ts`                   |
| Platform: analytics health on the device, detection events and overlay   | Done                                                                                       | `apps/server/test/vision.test.ts`  |
