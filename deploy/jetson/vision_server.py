#!/usr/bin/env python3
"""13STORE camera AI service for an NVIDIA Jetson (or any machine with a GPU).

The edge gateway's "http" detector posts one JPEG per frame to /detect and reads back the boxes:

    POST /detect   body: a JPEG (content-type image/jpeg)
    200 {"model": "yolov8s.engine", "ms": 6.4,
         "detections": [{"label": "person", "confidence": 0.91, "box": [x, y, w, h]}]}

Boxes are fractions of the frame (x, y = top-left corner). GET /health answers {"ok": true, ...}.
Zones, tracking, live boxes, incidents and evidence are the gateway's and the platform's job.

With --depth (Depth Anything V2 Small, ONNX) the answer also says how near things are, without a
unit: "depth" on each detection (the middle of the body) and "floor", [x, y, value] samples from the
lower part of the picture. The platform scales them to metres every frame against the floor it can
measure from the camera's height and tilt, for people too far away to measure from their feet:

    {"detections": [{"label": "person", ..., "depth": 1.83}], "floor": [[0.1, 0.55, 1.41], ...],
     "depthModel": "depth-anything-v2-small.onnx", "depthMs": 31.2}

Backends:
    --model yolov8s.engine   Ultralytics YOLO: a TensorRT engine built on this Jetson (fastest),
                             or an .onnx / .pt file. Needs the Ultralytics Jetson container or
                             `pip install ultralytics` with NVIDIA's PyTorch for JetPack.
    --fake                   no model, no GPU: a figure walking across the frame, to test the
                             wiring from camera to console before the model is in place.
    --depth model.onnx       also run Depth Anything V2 Small (onnxruntime: TensorRT or CUDA on the
                             Jetson, the CPU elsewhere) every --depth-every frames.

Guide (Thai): deploy/jetson/README_TH.md
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 8 * 1024 * 1024
DEFAULT_CLASSES = "person,bicycle,car,motorcycle,bus,truck"
# Floor samples for the depth scale: a grid over the lower part of the picture (fractions).
FLOOR_ROWS = [0.55 + 0.06 * i for i in range(8)]  # 0.55 ... 0.97
FLOOR_COLS = [0.1 + 0.1 * i for i in range(9)]  # 0.1 ... 0.9


class Fake:
    """A person walking left to right every six seconds."""

    name = "fake (no model)"

    def __init__(self):
        self.t0 = time.time()

    def detect(self, jpeg):
        if not jpeg.startswith(b"\xff\xd8"):
            raise ValueError("not a JPEG")
        phase = ((time.time() - self.t0) / 6.0) % 1.0
        return [{"label": "person", "confidence": 0.9, "box": [round(0.05 + 0.8 * phase, 4), 0.3, 0.1, 0.45]}]


class Yolo:
    """Ultralytics YOLO on the GPU. One frame at a time (the model is not shared between threads)."""

    def __init__(self, model, imgsz, conf, classes, device, half):
        import numpy as np  # noqa: imported here so --fake needs nothing installed
        import cv2
        from ultralytics import YOLO

        self.np, self.cv2 = np, cv2
        self.model = YOLO(model, task="detect")
        self.name = os.path.basename(model)
        self.imgsz, self.conf, self.device, self.half = imgsz, conf, device, half
        names = self.model.names  # class id -> name
        wanted = {c.strip() for c in classes.split(",") if c.strip()}
        self.classes = [i for i, n in names.items() if n in wanted] or None
        self.lock = threading.Lock()
        # The first run on a TensorRT engine is slow: do it now, not on the first frame.
        self.detect_image(np.zeros((imgsz, imgsz, 3), dtype=np.uint8))

    def detect(self, jpeg):
        img = self.cv2.imdecode(self.np.frombuffer(jpeg, self.np.uint8), self.cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("not a JPEG")
        return self.detect_image(img)

    def detect_image(self, img):
        # `half` only when asked for (.pt/.onnx): an engine keeps its own precision, and newer
        # Ultralytics warns on every call that passes it.
        extra = {"half": True} if self.half else {}
        with self.lock:
            r = self.model.predict(img, imgsz=self.imgsz, conf=self.conf, classes=self.classes, device=self.device, verbose=False, **extra)[0]
        out = []
        for (x0, y0, x1, y1), c, k in zip(r.boxes.xyxyn.tolist(), r.boxes.conf.tolist(), r.boxes.cls.tolist()):
            out.append({"label": r.names[int(k)], "confidence": round(float(c), 3), "box": [round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4)]})
        return out


class Depth:
    """Depth Anything V2 Small (ONNX): how near each pixel is, without a unit (bigger = nearer).

    Only raw values leave this service: one per detection, read over the body (the centre half of
    the box, 30-90% of the way down, centred where the platform's depthPointOf() looks), and a grid
    of floor samples. The platform turns them into metres each frame. A new map
    is made every `every` frames; the frames in between reuse the last one (people move little in a
    third of a second), which keeps room on the GPU for the detector.
    """

    MEAN = (0.485, 0.456, 0.406)
    STD = (0.229, 0.224, 0.225)

    def __init__(self, model, size, every, device):
        import numpy as np  # noqa: imported here so --fake without --depth needs nothing installed
        import cv2
        import onnxruntime as ort

        self.np, self.cv2 = np, cv2
        have = ort.get_available_providers()
        want = ["CPUExecutionProvider"] if device == "cpu" else ["TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]
        providers = []
        for p in want:
            if p not in have:
                continue
            if p == "TensorrtExecutionProvider":
                # FP16, and the engine kept next to the model: the first start builds it (minutes).
                cache = os.path.join(os.path.dirname(os.path.abspath(model)), "trt-cache")
                os.makedirs(cache, exist_ok=True)
                providers.append((p, {"trt_fp16_enable": True, "trt_engine_cache_enable": True, "trt_engine_cache_path": cache}))
            else:
                providers.append(p)
        self.session = ort.InferenceSession(model, providers=providers)
        self.input = self.session.get_inputs()[0].name
        self.name = os.path.basename(model)
        self.providers = self.session.get_providers()
        self.size = max(14, size // 14 * 14)
        self.every = max(1, every)
        self.count = 0
        self.map = None
        self.ms = None
        self.lock = threading.Lock()
        # The first run is slow (TensorRT builds its engine): do it now, for a 16:9 picture.
        self.infer(np.zeros((720, 1280, 3), dtype=np.uint8))

    def decode(self, jpeg):
        img = self.cv2.imdecode(self.np.frombuffer(jpeg, self.np.uint8), self.cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("not a JPEG")
        return img

    def infer(self, img):
        np, cv2 = self.np, self.cv2
        h, w = img.shape[:2]
        s = self.size / max(h, w)
        # The model takes sides that are multiples of 14.
        th, tw = max(14, round(h * s / 14) * 14), max(14, round(w * s / 14) * 14)
        x = cv2.cvtColor(cv2.resize(img, (tw, th), interpolation=cv2.INTER_CUBIC), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        x = ((x - np.array(self.MEAN, np.float32)) / np.array(self.STD, np.float32)).transpose(2, 0, 1)[None]
        t0 = time.perf_counter()
        out = self.session.run(None, {self.input: np.ascontiguousarray(x)})[0][0]
        self.ms = round((time.perf_counter() - t0) * 1000, 1)
        return out.astype(np.float32)

    def current(self, img):
        """This frame's depth map: a new one every `every` frames, else the last."""
        with self.lock:
            if self.map is None or self.count % self.every == 0:
                self.map = self.infer(img)
            self.count += 1
            return self.map

    def value(self, m, x0, y0, x1, y1, q=50):
        """The q-th percentile of the map over a box given in picture fractions, or None when it is empty."""
        h, w = m.shape
        a, b = max(0, int(x0 * w)), min(w, max(int(x0 * w) + 1, int(self.np.ceil(x1 * w))))
        c, d = max(0, int(y0 * h)), min(h, max(int(y0 * h) + 1, int(self.np.ceil(y1 * h))))
        patch = m[c:d, a:b]
        return float(self.np.percentile(patch, q)) if patch.size else None

    def annotate(self, img, detections):
        """Adds "depth" to each detection; returns the floor samples (not under any detection)."""
        m = self.current(img)
        for det in detections:
            x, y, bw, bh = det["box"]
            # A person is nearer than what shows around them in the box (a wall, the floor further
            # on), so a high value of the body area is theirs even when they are only a few pixels wide.
            v = self.value(m, x + bw * 0.25, y + bh * 0.3, x + bw * 0.75, y + bh * 0.9, q=85)
            if v is not None:
                det["depth"] = round(v, 4)
        boxes = [d["box"] for d in detections]
        floor = []
        for fy in FLOOR_ROWS:
            for fx in FLOOR_COLS:
                if any(bx <= fx <= bx + bw and by <= fy <= by + bh for bx, by, bw, bh in boxes):
                    continue
                v = self.value(m, fx - 0.01, fy - 0.01, fx + 0.01, fy + 0.01)
                if v is not None:
                    floor.append([round(fx, 3), round(fy, 3), round(v, 4)])
        return floor


def make_handler(backend, token, depth=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "13store-vision/1.0"

        def log_message(self, fmt, *args):  # quiet: one line per request would flood the journal
            pass

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") == "/health":
                extra = {"depthModel": depth.name, "depthProviders": depth.providers, "depthMs": depth.ms} if depth else {}
                return self.reply(200, {"ok": True, "model": backend.name, **extra})
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") != "/detect":
                return self.reply(404, {"error": "not found"})
            if token and self.headers.get("authorization") != f"Bearer {token}":
                return self.reply(401, {"error": "token required"})
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self.reply(413 if n > MAX_BODY else 400, {"error": "send one JPEG, up to 8 MB, with a content-length"})
            jpeg = self.rfile.read(n)
            t0 = time.perf_counter()
            extra = {}
            try:
                if depth:
                    # One decode for both models.
                    img = depth.decode(jpeg)
                    detections = backend.detect_image(img) if hasattr(backend, "detect_image") else backend.detect(jpeg)
                    extra = {"floor": depth.annotate(img, detections), "depthModel": depth.name, "depthMs": depth.ms}
                else:
                    detections = backend.detect(jpeg)
            except Exception as e:  # a bad frame must not stop the service
                print(f"[vision] detect failed: {e}", flush=True)
                return self.reply(400 if isinstance(e, ValueError) else 500, {"error": str(e)[:200]})
            self.reply(200, {"model": backend.name, "ms": round((time.perf_counter() - t0) * 1000, 1), "detections": detections, **extra})

    return Handler


def main():
    ap = argparse.ArgumentParser(description="13STORE camera AI service (JPEG in, boxes out).")
    ap.add_argument("--host", default="127.0.0.1", help="listen address; 127.0.0.1 when the gateway runs on this machine (default)")
    ap.add_argument("--port", type=int, default=8601)
    ap.add_argument("--model", help="model file: yolov8s.engine (TensorRT), .onnx or .pt")
    ap.add_argument("--imgsz", type=int, default=640, help="model input size (the size the engine was built for)")
    ap.add_argument("--conf", type=float, default=0.35, help="lowest confidence returned")
    ap.add_argument("--classes", default=DEFAULT_CLASSES, help="model classes to return, comma-separated")
    ap.add_argument("--device", default="0", help="GPU index (0) or cpu")
    ap.add_argument("--half", action="store_true", help="FP16 for .pt/.onnx models (an engine keeps the precision it was built with)")
    ap.add_argument("--token", default=os.environ.get("VISION_TOKEN", ""), help="require 'Authorization: Bearer <token>' (or set VISION_TOKEN)")
    ap.add_argument("--fake", action="store_true", help="no model: a walking figure, to test the wiring")
    ap.add_argument("--depth", help="also run a depth model (Depth Anything V2 Small .onnx) for distances far away")
    ap.add_argument("--depth-size", type=int, default=518, help="longest side the depth model sees, a multiple of 14 (default 518, the model's own: smaller misses people far away)")
    ap.add_argument("--depth-every", type=int, default=3, help="a new depth map every N frames (default 3)")
    a = ap.parse_args()
    # Settings kept next to the service (vision_server.json in the working directory) fill what the
    # command line leaves out, so the depth model can be switched on or off with a file and a restart
    # of the same container: {"depth": "/work/depth-anything-v2-small.onnx", "depthSize": 518, "depthEvery": 3}
    if os.path.exists("vision_server.json"):
        with open("vision_server.json", encoding="utf-8") as f:
            saved = json.load(f)
        if not a.depth and isinstance(saved.get("depth"), str) and saved["depth"]:
            a.depth = saved["depth"]
            a.depth_size = int(saved.get("depthSize", a.depth_size))
            a.depth_every = int(saved.get("depthEvery", a.depth_every))
            print(f"[vision] depth model from vision_server.json: {a.depth}", flush=True)
    if not a.fake and not a.model:
        ap.error("--model is required (or --fake to test the wiring)")
    backend = Fake() if a.fake else Yolo(a.model, a.imgsz, a.conf, a.classes, a.device, a.half)
    depth = Depth(a.depth, a.depth_size, a.depth_every, a.device) if a.depth else None
    server = ThreadingHTTPServer((a.host, a.port), make_handler(backend, a.token, depth))
    print(f"[vision] {backend.name} ready on http://{a.host}:{a.port}/detect", flush=True)
    if depth:
        print(f"[vision] depth: {depth.name} on {', '.join(depth.providers)}, {depth.ms} ms, every {depth.every} frames", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
