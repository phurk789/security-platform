// Edge vision: frames, detectors, zones and tracking, sources, and the adapter end to end.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  COCO_CLASSES,
  FfmpegSource,
  HttpDetector,
  floorSamples,
  JpegSplitter,
  MotionDetector,
  OnnxDetector,
  PushSource,
  ScriptedDetector,
  SnapshotSource,
  ThermalDetector,
  VisionCameraAdapter,
  VisionPipeline,
  components,
  cropJpeg,
  decodeJpeg,
  decodeYolo,
  encodeJpeg,
  inPolygon,
  letterbox,
  nms,
  paintFrame,
  toGrey,
  type Candidate,
  type LiveBoxes,
  type Emitted,
} from '../src/vision';
import { fakeCtx } from './helpers';

const W = 320;
const H = 240;
const BG: [number, number, number] = [40, 44, 52];
const near = (a: number, b: number, tol = 0.06) => Math.abs(a - b) <= tol;

describe('frames', () => {
  it('encodes and decodes JPEG, scales to grey, crops with margin, finds components', () => {
    const f = paintFrame(W, H, BG, [{ x: 100, y: 60, w: 40, h: 80, rgb: [220, 220, 220] }], 1000);
    const jpeg = encodeJpeg(f);
    const back = decodeJpeg(jpeg, 1000);
    expect([back.width, back.height]).toEqual([W, H]);
    expect(back.rgba[(100 * W + 120) * 4]).toBeGreaterThan(180);
    const g = toGrey(back, 160);
    expect([g.width, g.height]).toEqual([160, 120]);
    const crop = cropJpeg(back, [100 / W, 60 / H, 40 / W, 80 / H], { maxSide: 200 });
    expect(crop.mime).toBe('image/jpeg');
    const c = decodeJpeg(Buffer.from(crop.base64, 'base64'), 0);
    expect(c.width).toBeGreaterThanOrEqual(40);
    expect(c.width).toBeLessThan(80);
    const mask = new Uint8Array(16);
    mask[5] = mask[6] = mask[9] = 1;
    mask[15] = 1;
    const comps = components(mask, 4, 4, 2);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({ x0: 1, y0: 1, x1: 3, y1: 3, n: 3 });
    expect(
      inPolygon(0.5, 0.5, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBe(true);
    expect(
      inPolygon(1.5, 0.5, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBe(false);
    const lb = letterbox(back, 64);
    expect(lb.data.length).toBe(3 * 64 * 64);
    expect(lb.padY).toBeGreaterThan(0);
  });
});

describe('detectors', () => {
  it('motion: nothing on a static scene, a box where something moved, nothing when the whole scene changes', () => {
    const det = new MotionDetector({ width: 160 });
    const still = paintFrame(W, H, BG, []);
    expect(det.detect(still)).toEqual([]); // warm-up
    expect(det.detect(still)).toEqual([]);
    const moved = paintFrame(W, H, BG, [{ x: 200, y: 100, w: 30, h: 60, rgb: [230, 230, 230] }]);
    const c = det.detect(moved);
    expect(c).toHaveLength(1);
    expect(c[0].type).toBe('motion');
    expect(near(c[0].bbox[0], 200 / W)).toBe(true);
    expect(near(c[0].bbox[1], 100 / H)).toBe(true);
    expect(near(c[0].bbox[2], 30 / W)).toBe(true);
    expect(near(c[0].bbox[3], 60 / H)).toBe(true);
    const lights = paintFrame(W, H, [200, 200, 200], []);
    expect(det.detect(lights)).toEqual([]);
  });

  it('thermal: a hot blob becomes a hotspot with its temperature; cool scenes do not', () => {
    const det = new ThermalDetector({ minC: 0, maxC: 100, thresholdC: 60 });
    const cool = paintFrame(W, H, [60, 60, 60], []); // ≈ 23.5 °C
    expect(det.detect(cool)).toEqual([]);
    const hot = paintFrame(W, H, [60, 60, 60], [{ x: 150, y: 100, w: 20, h: 20, rgb: [200, 200, 200] }]); // ≈ 78 °C
    const c = det.detect(hot);
    expect(c).toHaveLength(1);
    expect(c[0].type).toBe('thermal_hotspot');
    expect(c[0].attributes?.temperatureC).toBeGreaterThan(75);
    expect(c[0].attributes?.temperatureC).toBeLessThan(80);
    expect(near(c[0].bbox[0], 150 / W)).toBe(true);
    expect(det.info().lastMaxC).toBeGreaterThan(75);
  });

  it('yolo decode + nms: attribute-major [1, 4+C, N] output, overlapping boxes collapse per class', () => {
    const C = COCO_CLASSES.length;
    const N = 3;
    const data = new Float32Array((4 + C) * N);
    const set = (i: number, cx: number, cy: number, w: number, h: number, cls: number, score: number) => {
      data[i] = cx;
      data[N + i] = cy;
      data[2 * N + i] = w;
      data[3 * N + i] = h;
      data[(4 + cls) * N + i] = score;
    };
    set(0, 320, 320, 100, 200, 0, 0.9); // person
    set(1, 325, 322, 100, 200, 0, 0.7); // same person
    set(2, 500, 400, 120, 80, 2, 0.8); // car
    const raw = decodeYolo(data, [1, 4 + C, N], { size: 640, scale: 1, padX: 0, padY: 0, frameW: 640, frameH: 640, classes: COCO_CLASSES, minConfidence: 0.3 });
    expect(raw).toHaveLength(3);
    const kept = nms(raw, 0.45);
    expect(kept.map((k) => k.label)).toEqual(['person', 'car']);
    expect(near(kept[0].bbox[0], (320 - 50) / 640, 0.01)).toBe(true);
    // v5-style [1, N, 5+C] with objectness
    const d5 = new Float32Array(N * (5 + C));
    d5.set([320, 320, 100, 200, 0.9, 1], 0);
    const r5 = decodeYolo(d5, [1, N, 5 + C], { size: 640, scale: 1, padX: 0, padY: 0, frameW: 640, frameH: 640, classes: COCO_CLASSES, minConfidence: 0.3 });
    expect(r5).toHaveLength(1);
    expect(r5[0].label).toBe('person');
    expect(() => decodeYolo(d5, [1, 7, 7], { size: 640, scale: 1, padX: 0, padY: 0, frameW: 640, frameH: 640, classes: COCO_CLASSES, minConfidence: 0.3 })).toThrow(/output shape/);
  });

  it('onnx: runs through a runtime module, maps classes to detection types; a missing runtime is explained', async () => {
    const C = COCO_CLASSES.length;
    const fakeOrt = {
      Tensor: class {
        constructor(
          public type: string,
          public data: Float32Array,
          public dims: number[],
        ) {}
      },
      InferenceSession: {
        async create(path: string) {
          expect(path).toBe('/models/yolov8n.onnx');
          return {
            inputNames: ['images'],
            outputNames: ['output0'],
            async run(feeds: Record<string, { dims: number[] }>) {
              expect(feeds.images.dims).toEqual([1, 3, 640, 640]);
              const N = 2;
              const data = new Float32Array((4 + C) * N);
              data[0] = 320;
              data[N] = 400;
              data[2 * N] = 60;
              data[3 * N] = 160;
              data[4 * N] = 0.88; // person
              data[1] = 100;
              data[N + 1] = 500;
              data[2 * N + 1] = 120;
              data[3 * N + 1] = 60;
              data[(4 + 7) * N + 1] = 0.77; // truck
              return { output0: { data, dims: [1, 4 + C, N] } };
            },
          };
        },
      },
    };
    const det = new OnnxDetector({ model: '/models/yolov8n.onnx' }, () => fakeOrt);
    const out = await det.detect(paintFrame(640, 640, BG, []));
    expect(out.map((o) => [o.type, o.label])).toEqual([
      ['person', 'person'],
      ['vehicle', 'truck'],
    ]);
    expect(det.info()).toMatchObject({ model: '/models/yolov8n.onnx', frames: 1 });
    const missing = new OnnxDetector({ model: '/models/x.onnx' }, () => {
      throw new Error("Cannot find module 'onnxruntime-node'");
    });
    await expect(missing.detect(paintFrame(64, 64, BG, []))).rejects.toThrow(/npm i onnxruntime-node/);
  });
});

describe('pipeline', () => {
  const person = (x: number, y: number, conf = 0.9): Candidate => ({ type: 'person', confidence: conf, bbox: [x, y, 0.08, 0.25], label: 'person' });

  it('zones, persistence, cooldown, crowd and loitering; emits a JPEG crop with each detection', async () => {
    let now = 1_000_000;
    const script: { cands: Candidate[] } = { cands: [] };
    const out: Emitted[] = [];
    const p = new VisionPipeline(
      {
        detectors: { motion: true },
        zones: [
          {
            id: 'gate',
            name: 'Service gate',
            kind: 'protected',
            poly: [
              [0, 0.5],
              [0.5, 0.5],
              [0.5, 1],
              [0, 1],
            ],
            zone: 'Zone B',
            place: 'Service gate',
          },
          {
            id: 'road',
            name: 'Public road',
            kind: 'ignore',
            poly: [
              [0.5, 0],
              [1, 0],
              [1, 0.3],
              [0.5, 0.3],
            ],
          },
          {
            id: 'plaza',
            name: 'Plaza',
            kind: 'count',
            poly: [
              [0.5, 0.5],
              [1, 0.5],
              [1, 1],
              [0.5, 1],
            ],
            crowdMin: 3,
          },
        ],
        minFrames: 2,
        cooldownS: 30,
        loiterS: 10,
        sourceName: 'Test vision',
      },
      { onDetection: (d) => out.push(d), now: () => now },
    );
    p.detectors.length = 0; // replace the motion detector with a scripted one for determinism
    p.use(new ScriptedDetector(() => script.cands));
    const frame = paintFrame(W, H, BG, [{ x: 40, y: 150, w: 25, h: 60, rgb: [230, 230, 230] }]);
    const step = async (ms = 1000) => {
      now += ms;
      await p.frame({ ...frame, at: now }, now);
    };
    // One frame is not enough (minFrames 2); the second reports an intrusion in the protected zone.
    script.cands = [person(0.1, 0.6), person(0.7, 0.02)]; // second person stands on the ignored public road
    await step();
    expect(out).toHaveLength(0);
    await step();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'intrusion', source: 'Test vision', zone: 'Zone B', place: 'Service gate', attributes: { label: 'person' } });
    expect(out[0].snapshot?.mime).toBe('image/jpeg');
    expect(out[0].snapshot!.base64.length).toBeGreaterThan(500);
    expect(out[0].bbox).toEqual([0.1, 0.6, 0.08, 0.25]);
    // Cooldown: the same thing in the same zone is not reported again for 30 s.
    await step();
    await step();
    expect(out).toHaveLength(1);
    // Loitering: the tracked person has been there 10 s.
    for (let i = 0; i < 8; i++) await step();
    expect(out.some((d) => d.type === 'loitering')).toBe(true);
    expect(out.filter((d) => d.type === 'loitering')).toHaveLength(1);
    // Crowd: three people in the count zone.
    script.cands = [person(0.6, 0.6), person(0.7, 0.62), person(0.8, 0.58)];
    await step();
    const crowd = out.find((d) => d.type === 'crowd');
    expect(crowd).toBeTruthy();
    expect(crowd!.attributes?.count).toBe(3);
    expect(crowd!.place).toBe('Plaza');
    // Persistence resets when the thing disappears for a frame.
    script.cands = [];
    await step();
    script.cands = [person(0.1, 0.6)];
    now += 60_000;
    await step();
    expect(out.filter((d) => d.type === 'intrusion')).toHaveLength(1);
    await step();
    expect(out.filter((d) => d.type === 'intrusion')).toHaveLength(2);
    const st = p.status();
    expect(st.frames).toBeGreaterThan(10);
    expect(st.detections).toBe(out.length);
    expect(st.fps).toBeGreaterThan(0);
  });

  it('reports live boxes for the console: people keep their number, at most 5 a second, one empty list when they leave', async () => {
    let now = 2_000_000;
    const script: { cands: Candidate[] } = { cands: [] };
    const boxes: LiveBoxes[] = [];
    const p = new VisionPipeline({ detectors: { motion: true }, minFrames: 2, cooldownS: 30 }, { onDetection: () => {}, onBoxes: (b) => boxes.push(b), now: () => now });
    p.detectors.length = 0;
    p.use(new ScriptedDetector(() => script.cands));
    const frame = paintFrame(W, H, BG, []);
    const step = async (ms: number) => {
      now += ms;
      await p.frame({ ...frame, at: now }, now);
    };
    // Nothing in view and nothing shown: nothing is sent.
    await step(300);
    expect(boxes).toHaveLength(0);
    // Two people walk in; the first frame is sent at once, with a number for each.
    script.cands = [person(0.1, 0.5), person(0.6, 0.4)];
    await step(300);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ width: W, height: H });
    const ids = boxes[0].boxes.map((b) => b.id);
    expect(ids.every((id) => Number.isInteger(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    // Frames faster than 200 ms apart are not all sent.
    await step(50);
    expect(boxes).toHaveLength(1);
    // They move a little: same numbers.
    script.cands = [person(0.11, 0.5), person(0.61, 0.41)];
    await step(250);
    expect(boxes).toHaveLength(2);
    expect(boxes[1].boxes.map((b) => b.id)).toEqual(ids);
    // They leave: one empty list right away (no throttle), then silence.
    script.cands = [];
    await step(10);
    expect(boxes).toHaveLength(3);
    expect(boxes[2].boxes).toEqual([]);
    await step(300);
    expect(boxes).toHaveLength(3);
  });

  it('takes JPEG bytes from a source and skips frames while busy', async () => {
    const out: Emitted[] = [];
    const p = new VisionPipeline(
      { detectors: { thermal: { minC: 0, maxC: 100, thresholdC: 60 } }, minConfidence: 0.5, snapshot: false, zone: 'Zone A' },
      { onDetection: (d) => out.push(d) },
    );
    const src = new PushSource();
    p.start(src);
    const hot = encodeJpeg(paintFrame(W, H, [60, 60, 60], [{ x: 150, y: 100, w: 20, h: 20, rgb: [200, 200, 200] }]));
    src.push(hot, 5000);
    await new Promise((r) => setTimeout(r, 50));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'thermal_hotspot', zone: 'Zone A', snapshot: undefined });
    expect(p.status().source).toBe('push');
    p.stop();
    expect(p.status().running).toBe(false);
  });
});

describe('http detector (AI service on a Jetson or GPU box)', () => {
  /** A fake AI service: records requests, answers with what the test sets. */
  async function fakeService(answer: (body: Buffer) => { status?: number; delayMs?: number; json?: unknown }) {
    const got: { type?: string; auth?: string; body: Buffer }[] = [];
    const server = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        const body = Buffer.concat(parts);
        got.push({ type: req.headers['content-type'], auth: req.headers.authorization, body });
        const a = answer(body);
        setTimeout(() => {
          res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(a.json ?? {}));
        }, a.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/detect`, got, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('sends the original JPEG, maps model classes, drops weak, unknown and empty boxes, trims to the frame', async () => {
    const svc = await fakeService(() => ({
      json: {
        model: 'yolov8s.engine (TensorRT FP16)',
        ms: 6.43,
        detections: [
          { label: 'person', confidence: 0.91, box: [0.1, 0.2, 0.1, 0.4] },
          { label: 'car', confidence: 0.8, bbox: [0.9, 0.5, 0.3, 0.2] },
          { label: 'person', confidence: 0.2, box: [0.5, 0.5, 0.1, 0.1] },
          { label: 'dog', confidence: 0.99, box: [0.3, 0.3, 0.1, 0.1] },
          { label: 'person', confidence: 0.9, box: [0.4, 0.4, 0, 0.1] },
          { label: 'person', confidence: 0.9, box: [0.4, 0.4, 'x', 0.1] },
        ],
      },
    }));
    const det = new HttpDetector({ url: svc.url, headers: { authorization: 'Bearer t0k' } });
    const jpeg = encodeJpeg(paintFrame(W, H, BG, []));
    const frame = decodeJpeg(jpeg, 1000);
    const c = await det.detect(frame);
    expect(svc.got).toHaveLength(1);
    expect(svc.got[0].type).toBe('image/jpeg');
    expect(svc.got[0].auth).toBe('Bearer t0k');
    expect(Buffer.compare(svc.got[0].body, Buffer.from(jpeg))).toBe(0);
    expect(c).toEqual([
      { type: 'person', confidence: 0.91, bbox: [0.1, 0.2, 0.1, 0.4], label: 'person', attributes: { label: 'person' } },
      { type: 'vehicle', confidence: 0.8, bbox: [0.9, 0.5, 0.1, 0.2], label: 'car', attributes: { label: 'car' } },
    ]);
    expect(det.info()).toMatchObject({ model: 'yolov8s.engine (TensorRT FP16)', inferenceMs: 6.4, frames: 1 });
    await svc.close();
  });

  it('a frame without its JPEG is encoded; a refusal or no answer pauses the service, then it is tried again', async () => {
    let mode: 'ok' | 'error' | 'slow' = 'error';
    const svc = await fakeService(() =>
      mode === 'error' ? { status: 503, json: { error: 'model loading' } } : mode === 'slow' ? { delayMs: 300, json: { detections: [] } } : { json: { detections: [{ label: 'person', confidence: 0.7, box: [0, 0, 0.5, 0.5] }] } },
    );
    let now = 10_000;
    const det = new HttpDetector({ url: svc.url, retryMs: 2000, timeoutMs: 100 }, fetch, () => now);
    const frame = paintFrame(W, H, BG, []);
    await expect(det.detect(frame)).rejects.toThrow(/answered 503/);
    expect(det.info().error).toMatch(/answered 503/);
    // Paused: no request for 2 s.
    now += 1000;
    expect(await det.detect(frame)).toEqual([]);
    expect(svc.got).toHaveLength(1);
    // No answer in time.
    now += 1500;
    mode = 'slow';
    await expect(det.detect(frame)).rejects.toThrow(/no answer within 100 ms/);
    now += 2500;
    mode = 'ok';
    expect(await det.detect(frame)).toHaveLength(1);
    expect(svc.got.at(-1)!.body[0]).toBe(0xff); // encoded on the gateway: still a JPEG
    expect(det.info().error).toBeUndefined();
    await svc.close();
  });

  it('refuses a config without an http URL', () => {
    expect(() => new HttpDetector({ url: 'jetson:8601' })).toThrow(/must be an http\(s\) URL/);
  });

  it('in the pipeline: the service sees people, the pipeline numbers them and raises the intrusion', async () => {
    const svc = await fakeService(() => ({ json: { detections: [{ label: 'person', confidence: 0.88, box: [0.4, 0.3, 0.1, 0.4] }] } }));
    const boxes: LiveBoxes[] = [];
    const out: Emitted[] = [];
    const p = new VisionPipeline(
      { detectors: { http: { url: svc.url } }, zones: [{ id: 'all', name: 'Yard', kind: 'protected', poly: [[0, 0], [1, 0], [1, 1], [0, 1]] }], minFrames: 2 },
      { onDetection: (d) => out.push(d), onBoxes: (b) => boxes.push(b) },
    );
    const jpeg = encodeJpeg(paintFrame(W, H, BG, []));
    await p.frameBytes(jpeg, 1000);
    await p.frameBytes(jpeg, 1300);
    expect(boxes[0].boxes[0]).toMatchObject({ type: 'intrusion', label: 'person', confidence: 0.88 });
    expect(boxes[0].boxes[0].id).toBe(boxes[1].boxes[0].id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'intrusion', attributes: { label: 'person' } });
    expect(p.status().detectors.http).toMatchObject({ frames: 2 });
    await svc.close();
  });

  it('with a depth model: each box keeps its depth value and the floor samples go out with the live boxes', async () => {
    const floor = [[0.1, 0.55, 1.4], [0.5, 0.97, 7.25], [1.2, 0.6, 2], [0.5, 0.6, 'x'], [0.3, 0.7]];
    const svc = await fakeService(() => ({
      json: { model: 'yolov8s.engine', depthModel: 'model.onnx', depthMs: 31.27, detections: [{ label: 'person', confidence: 0.88, box: [0.4, 0.3, 0.1, 0.4], depth: 1.83 }], floor },
    }));
    const boxes: LiveBoxes[] = [];
    const p = new VisionPipeline({ detectors: { http: { url: svc.url } }, minFrames: 2 }, { onDetection: () => {}, onBoxes: (b) => boxes.push(b) });
    await p.frameBytes(encodeJpeg(paintFrame(W, H, BG, [])), 1000);
    // Only well-formed samples inside the frame are kept.
    expect(boxes[0].floor).toEqual([[0.1, 0.55, 1.4], [0.5, 0.97, 7.25]]);
    expect(boxes[0].boxes[0]).toMatchObject({ type: 'person', depthRel: 1.83 });
    expect(p.status().detectors.http).toMatchObject({ depthModel: 'model.onnx', depthMs: 31.3 });
    // Without a depth model nothing extra is sent.
    expect(floorSamples(undefined)).toBeUndefined();
    expect(floorSamples([[2, 2, 2]])).toBeUndefined();
    await svc.close();
  });
});

describe('sources', () => {
  it('splits a byte stream into JPEG frames', () => {
    const frames: number[] = [];
    const sp = new JpegSplitter((j) => frames.push(j.length));
    const a = encodeJpeg(paintFrame(32, 32, BG, []));
    const b = encodeJpeg(paintFrame(48, 32, BG, []));
    const all = Buffer.concat([Buffer.from('--boundary\r\nContent-Type: image/jpeg\r\n\r\n'), a, Buffer.from('\r\n--boundary\r\n\r\n'), b]);
    for (let i = 0; i < all.length; i += 7) sp.push(all.subarray(i, i + 7));
    expect(frames).toEqual([a.length, b.length]);
  });

  it('polls a snapshot URL with Basic auth', async () => {
    const jpeg = encodeJpeg(paintFrame(64, 48, BG, []));
    let hits = 0;
    const srv = http.createServer((req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from('cam:secret').toString('base64')}`) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="cam"' });
        return res.end();
      }
      hits++;
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(jpeg);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const got: number[] = [];
    const src = SnapshotSource.url(`http://127.0.0.1:${port}/snap.jpg`, 40, { username: 'cam', password: 'secret' });
    src.start(
      (j) => got.push(j.length),
      (e) => {
        throw e;
      },
    );
    await new Promise((r) => setTimeout(r, 250));
    src.stop();
    srv.close();
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(got[0]).toBe(jpeg.length);
    // Every frame came from an authorised request; one request may still have been on its way when it stopped.
    expect(hits - got.length).toBeGreaterThanOrEqual(0);
    expect(hits - got.length).toBeLessThanOrEqual(1);
  });

  it('samples frames from anything ffmpeg can open (skipped when ffmpeg is not installed)', async () => {
    let has = true;
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
    } catch {
      has = false;
    }
    if (!has) return;
    expect(FfmpegSource.args({ input: 'rtsp://cam/live', fps: 2 })).toEqual(
      expect.arrayContaining(['-rtsp_transport', 'tcp', '-i', 'rtsp://cam/live', '-vf', 'fps=2', '-f', 'image2pipe']),
    );
    const got: number[] = [];
    const src = new FfmpegSource({ input: 'testsrc=size=160x120:rate=5', fps: 5, extraArgs: ['-f', 'lavfi'] });
    const errs: string[] = [];
    src.start(
      (j, at) => {
        got.push(j.length);
        expect(at).toBeGreaterThan(0);
      },
      (e) => errs.push(e.message),
    );
    await new Promise((r) => setTimeout(r, 2500));
    src.stop();
    expect(errs).toEqual([]);
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(() => decodeJpeg(got.length ? Buffer.alloc(0) : Buffer.alloc(0), 0)).toThrow();
  }, 10_000);
});

describe('adapter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vision-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('declares an analytics camera, reports health and raises detections with evidence frames from a folder of pictures', async () => {
    writeFileSync(join(dir, '01.jpg'), encodeJpeg(paintFrame(W, H, BG, [])));
    writeFileSync(join(dir, '02.jpg'), encodeJpeg(paintFrame(W, H, BG, [])));
    writeFileSync(join(dir, '03.jpg'), encodeJpeg(paintFrame(W, H, BG, [{ x: 200, y: 100, w: 30, h: 60, rgb: [230, 230, 230] }])));
    writeFileSync(join(dir, '04.jpg'), encodeJpeg(paintFrame(W, H, BG, [{ x: 204, y: 102, w: 30, h: 60, rgb: [230, 230, 230] }])));
    const { ctx, got } = fakeCtx();
    const a = new VisionCameraAdapter({
      deviceId: 'CAM-NVR-7',
      model: 'NVR channel 7',
      pos: { x: 300, y: 200 },
      vision: { source: { kind: 'folder', dir, intervalMs: 30 }, detectors: { motion: { width: 160 } }, minFrames: 1, cooldownS: 5, zone: 'Zone B', place: 'Loading bay' },
      healthMs: 100,
    });
    expect(a.declaration).toMatchObject({ kind: 'cctv', capabilities: ['video', 'analytics'], commands: [] });
    a.start(ctx);
    await vi.waitFor(() => expect(got.events.some((e) => e.kind === 'detection')).toBe(true), { timeout: 3000 });
    await vi.waitFor(() => expect(got.events.some((e) => e.kind === 'analytics')).toBe(true), { timeout: 3000 });
    a.stop();
    const det = got.events.find((e) => e.kind === 'detection')!;
    expect(det.detection).toMatchObject({ type: 'motion', source: 'Edge vision', zone: 'Zone B', place: 'Loading bay' });
    expect(det.detection!.bbox![0]).toBeGreaterThan(0.5);
    expect(det.detection!.snapshot?.mime).toBe('image/jpeg');
    const health = got.events.filter((e) => e.kind === 'analytics').pop()!;
    expect(health.analytics).toMatchObject({ provider: 'edge-vision', source: 'folder' });
    expect(health.analytics!.frames).toBeGreaterThan(2);
    expect(got.telemetry.length).toBeGreaterThan(0);
    // Motion was seen, so live boxes went out for the console too.
    expect(got.tracks.length).toBeGreaterThan(0);
    expect(got.tracks.some((t) => t.boxes.some((b) => b.type === 'motion'))).toBe(true);
  });

  it('a camera AI with a follow source waits for the read pass, reads it, and switches when it is renewed', async () => {
    const { ctx, got } = fakeCtx();
    const sources: { url: string; src: PushSource }[] = [];
    const a = new VisionCameraAdapter(
      { deviceId: 'UGV-01-AI', pos: { x: 0, y: 0 }, follows: 'UGV-01', vision: { source: { kind: 'follow', fps: 4 }, detectors: { thermal: { minC: 0, maxC: 100, thresholdC: 60 } }, snapshot: false } },
      (url, s) => {
        expect(s).toEqual({ kind: 'follow', fps: 4 });
        const src = new PushSource();
        sources.push({ url, src });
        return src;
      },
    );
    a.start(ctx);
    expect(sources).toHaveLength(0);
    a.onMediaRead('rtsp://read:r1.aaa@media:18554/ugv-01');
    a.onMediaRead('rtsp://read:r1.aaa@media:18554/ugv-01'); // the same pass again: nothing to do
    expect(sources.map((s) => s.url)).toEqual(['rtsp://read:r1.aaa@media:18554/ugv-01']);
    const hot = encodeJpeg(paintFrame(W, H, [60, 60, 60], [{ x: 150, y: 100, w: 20, h: 20, rgb: [200, 200, 200] }]));
    sources[0].src.push(hot, Date.now());
    await vi.waitFor(() => expect(got.events.some((e) => e.kind === 'detection')).toBe(true));
    expect(got.tracks.at(-1)!.boxes[0]).toMatchObject({ type: 'thermal_hotspot' });
    // A reconnect brings a renewed pass: the old reader stops, a new one starts.
    a.onMediaRead('rtsp://read:r1.bbb@media:18554/ugv-01');
    expect(sources).toHaveLength(2);
    expect(sources[1].url).toContain('r1.bbb');
    a.stop();
  });

  it('a camera AI on the video of a vehicle declares the vehicle it follows', () => {
    const a = new VisionCameraAdapter({
      deviceId: 'UGV-01-AI',
      pos: { x: 0, y: 0 },
      follows: 'UGV-01',
      vision: { source: { kind: 'folder', dir }, detectors: { motion: true } },
    });
    expect(a.declaration).toMatchObject({ deviceId: 'UGV-01-AI', follows: 'UGV-01', capabilities: ['video', 'analytics'] });
  });
});
