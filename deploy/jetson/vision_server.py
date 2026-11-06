#!/usr/bin/env python3
"""13STORE camera AI service for an NVIDIA Jetson (or any machine with a GPU).

The edge gateway's "http" detector posts one JPEG per frame to /detect and reads back the boxes:

    POST /detect   body: a JPEG (content-type image/jpeg)
    200 {"model": "yolov8s.engine", "ms": 6.4,
         "detections": [{"label": "person", "confidence": 0.91, "box": [x, y, w, h]}]}

Boxes are fractions of the frame (x, y = top-left corner). GET /health answers {"ok": true, ...}.
Zones, tracking, live boxes, incidents and evidence are the gateway's and the platform's job.

Backends:
    --model yolov8s.engine   Ultralytics YOLO: a TensorRT engine built on this Jetson (fastest),
                             or an .onnx / .pt file. Needs the Ultralytics Jetson container or
                             `pip install ultralytics` with NVIDIA's PyTorch for JetPack.
    --fake                   no model, no GPU: a figure walking across the frame, to test the
                             wiring from camera to console before the model is in place.

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


def make_handler(backend, token):
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
                return self.reply(200, {"ok": True, "model": backend.name})
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
            try:
                detections = backend.detect(jpeg)
            except Exception as e:  # a bad frame must not stop the service
                print(f"[vision] detect failed: {e}", flush=True)
                return self.reply(400 if isinstance(e, ValueError) else 500, {"error": str(e)[:200]})
            self.reply(200, {"model": backend.name, "ms": round((time.perf_counter() - t0) * 1000, 1), "detections": detections})

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
    a = ap.parse_args()
    if not a.fake and not a.model:
        ap.error("--model is required (or --fake to test the wiring)")
    backend = Fake() if a.fake else Yolo(a.model, a.imgsz, a.conf, a.classes, a.device, a.half)
    server = ThreadingHTTPServer((a.host, a.port), make_handler(backend, a.token))
    print(f"[vision] {backend.name} ready on http://{a.host}:{a.port}/detect", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
