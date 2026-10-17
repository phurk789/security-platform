// Detectors that turn a frame into candidate detections. Three kinds:
//  - motion: background subtraction, no model, any camera (the classic "something moved here");
//  - thermal: temperature from a thermal camera's grey level against a configured span, hotspots
//    above a threshold (fire, overheating equipment);
//  - onnx: an object-detection model (YOLOv8 / YOLO11 / YOLOv5 export) run with onnxruntime-node,
//    which the edge PC installs separately (`npm i onnxruntime-node`) along with the model file.
import { createRequire } from 'node:module';
import type { DetectionType } from '@13store/shared';
import { boxIoU, components, letterbox, toGrey, type Box, type Frame, type GreyFrame } from './frames';

export interface Candidate {
  type: DetectionType;
  confidence: number;
  bbox: Box;
  /** Model class or other label (e.g. "car", "hotspot"). */
  label?: string;
  attributes?: { temperatureC?: number; count?: number; label?: string };
}

export interface Detector {
  readonly name: string;
  /** Candidates in this frame. May return [] while warming up. */
  detect(frame: Frame, at: number): Promise<Candidate[]> | Candidate[];
  /** For the health report. */
  info(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------
// Motion

export interface MotionConfig {
  /** Processing width in pixels (frames are scaled down to this). Default 160. */
  width?: number;
  /** Grey-level difference that counts as changed (0–255). Default 28. */
  threshold?: number;
  /** Smallest changed region, as a fraction of the frame. Default 0.004 (≈ 0.4 %). */
  minArea?: number;
  /** Largest region before it counts as a global change (lighting, camera moved). Default 0.6. */
  maxArea?: number;
  /** Background adaptation per frame (0–1). Default 0.05. */
  learnRate?: number;
}

export class MotionDetector implements Detector {
  readonly name = 'motion';
  private bg?: Float32Array;
  private w = 0;
  private h = 0;
  private frames = 0;
  constructor(private readonly cfg: MotionConfig = {}) {}
  detect(frame: Frame): Candidate[] {
    const g = toGrey(frame, this.cfg.width ?? 160);
    const thr = this.cfg.threshold ?? 28;
    if (!this.bg || this.w !== g.width || this.h !== g.height) {
      this.bg = Float32Array.from(g.data);
      this.w = g.width;
      this.h = g.height;
      this.frames = 1;
      return [];
    }
    this.frames++;
    const n = g.width * g.height;
    const mask = new Uint8Array(n);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(g.data[i] - this.bg[i]);
      if (d > thr) {
        mask[i] = Math.min(255, d);
        changed++;
      }
    }
    const rate = this.cfg.learnRate ?? 0.05;
    for (let i = 0; i < n; i++) this.bg[i] += (g.data[i] - this.bg[i]) * rate;
    const minPx = Math.max(4, Math.round(n * (this.cfg.minArea ?? 0.004)));
    if (changed / n > (this.cfg.maxArea ?? 0.6)) return []; // whole scene changed: light, pan, or glitch
    const dil = dilate(mask, g.width, g.height);
    return components(dil, g.width, g.height, minPx).map((c) => ({
      type: 'motion' as const,
      confidence: Math.min(1, 0.5 + (c.sum / c.n / 255) * 0.5),
      bbox: [c.x0 / g.width, c.y0 / g.height, (c.x1 - c.x0) / g.width, (c.y1 - c.y0) / g.height] as Box,
      label: 'motion',
    }));
  }
  info() {
    return { frames: this.frames, width: this.w, height: this.h };
  }
}

/** One-pixel dilation so a moving object does not split into many fragments. */
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = mask[i];
      if (!v) {
        if (x > 0) v = v || mask[i - 1];
        if (x < w - 1) v = v || mask[i + 1];
        if (y > 0) v = v || mask[i - w];
        if (y < h - 1) v = v || mask[i + w];
      }
      out[i] = v;
    }
  return out;
}

// ---------------------------------------------------------------------------------------
// Thermal

export interface ThermalConfig {
  /** Temperatures the camera's grey levels 0 and 255 stand for (fixed-span output). */
  minC: number;
  maxC: number;
  /** Raise a hotspot above this temperature. Default 60 °C. */
  thresholdC?: number;
  /** Smallest hot region as a fraction of the frame. Default 0.001. */
  minArea?: number;
  /** Processing width. Default 160. */
  width?: number;
}

export class ThermalDetector implements Detector {
  readonly name = 'thermal';
  private frames = 0;
  private lastMaxC = 0;
  constructor(private readonly cfg: ThermalConfig) {}
  tempOf(level: number) {
    return this.cfg.minC + (level / 255) * (this.cfg.maxC - this.cfg.minC);
  }
  detect(frame: Frame): Candidate[] {
    const g: GreyFrame = toGrey(frame, this.cfg.width ?? 160);
    this.frames++;
    const thr = this.cfg.thresholdC ?? 60;
    const n = g.width * g.height;
    const mask = new Uint8Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = g.data[i];
      if (v > max) max = v;
      if (this.tempOf(v) >= thr) mask[i] = v;
    }
    this.lastMaxC = this.tempOf(max);
    const minPx = Math.max(2, Math.round(n * (this.cfg.minArea ?? 0.001)));
    return components(mask, g.width, g.height, minPx).map((c) => {
      let peak = 0;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) peak = Math.max(peak, g.data[y * g.width + x]);
      const t = Math.round(this.tempOf(peak) * 10) / 10;
      return {
        type: 'thermal_hotspot' as const,
        confidence: Math.min(1, 0.6 + Math.min(0.4, (t - thr) / 100)),
        bbox: [c.x0 / g.width, c.y0 / g.height, (c.x1 - c.x0) / g.width, (c.y1 - c.y0) / g.height] as Box,
        label: 'hotspot',
        attributes: { temperatureC: t },
      };
    });
  }
  info() {
    return { frames: this.frames, lastMaxC: Math.round(this.lastMaxC * 10) / 10, thresholdC: this.cfg.thresholdC ?? 60 };
  }
}

// ---------------------------------------------------------------------------------------
// ONNX object detection (YOLO family)

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush',
];

/** Default mapping from model classes to platform detection types. */
export const DEFAULT_CLASS_MAP: Record<string, DetectionType> = {
  person: 'person',
  bicycle: 'vehicle',
  car: 'vehicle',
  motorcycle: 'vehicle',
  bus: 'vehicle',
  truck: 'vehicle',
  fire: 'fire',
  smoke: 'smoke',
  flame: 'fire',
};

export interface OnnxConfig {
  /** Path to the .onnx file (YOLOv8n/s, YOLO11n, or a YOLOv5 export). */
  model: string;
  /** Module to load the runtime from. Default "onnxruntime-node". */
  runtime?: string;
  /** Model input size (square). Default 640. */
  inputSize?: number;
  /** Class names in model order. Default COCO-80. */
  classes?: string[];
  /** Only these classes are reported (model names). Default: those in classMap. */
  include?: string[];
  /** Model class → detection type. Default DEFAULT_CLASS_MAP. */
  classMap?: Record<string, DetectionType>;
  minConfidence?: number;
  iouThreshold?: number;
  /** Execution providers in preference order, e.g. ["cuda", "cpu"]. */
  providers?: string[];
}

interface OrtLike {
  InferenceSession: { create(path: string, opts?: unknown): Promise<{ inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | ArrayLike<number>; dims: number[] }>> }> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

/** Decodes YOLO outputs: [1, 4+C, N] (v8/11) or [1, N, 5+C] (v5, with objectness) into frame-relative boxes. */
export function decodeYolo(data: ArrayLike<number>, dims: number[], opts: { size: number; scale: number; padX: number; padY: number; frameW: number; frameH: number; classes: string[]; minConfidence: number }): (Candidate & { cls: number })[] {
  const out: (Candidate & { cls: number })[] = [];
  const C = opts.classes.length;
  const pushBox = (cx: number, cy: number, w: number, h: number, score: number, cls: number) => {
    if (score < opts.minConfidence || cls < 0 || cls >= C) return;
    const x0 = Math.max(0, (cx - w / 2 - opts.padX) / opts.scale / opts.frameW);
    const y0 = Math.max(0, (cy - h / 2 - opts.padY) / opts.scale / opts.frameH);
    const x1 = Math.min(1, (cx + w / 2 - opts.padX) / opts.scale / opts.frameW);
    const y1 = Math.min(1, (cy + h / 2 - opts.padY) / opts.scale / opts.frameH);
    if (x1 <= x0 || y1 <= y0) return;
    out.push({ type: 'other', confidence: Math.round(score * 1000) / 1000, bbox: [x0, y0, x1 - x0, y1 - y0], label: opts.classes[cls], cls });
  };
  if (dims.length === 3 && dims[1] === 4 + C && dims[2] !== 5 + C) {
    // [1, 4+C, N]: attribute-major
    const N = dims[2];
    for (let i = 0; i < N; i++) {
      let best = 0;
      let cls = -1;
      for (let c = 0; c < C; c++) {
        const s = data[(4 + c) * N + i];
        if (s > best) {
          best = s;
          cls = c;
        }
      }
      pushBox(data[i], data[N + i], data[2 * N + i], data[3 * N + i], best, cls);
    }
  } else if (dims.length === 3 && (dims[2] === 5 + C || dims[2] === 4 + C)) {
    // [1, N, 5+C] (objectness) or [1, N, 4+C]
    const N = dims[1];
    const stride = dims[2];
    const hasObj = stride === 5 + C;
    for (let i = 0; i < N; i++) {
      const o = i * stride;
      const obj = hasObj ? data[o + 4] : 1;
      let best = 0;
      let cls = -1;
      for (let c = 0; c < C; c++) {
        const s = data[o + (hasObj ? 5 : 4) + c] * obj;
        if (s > best) {
          best = s;
          cls = c;
        }
      }
      pushBox(data[o], data[o + 1], data[o + 2], data[o + 3], best, cls);
    }
  } else throw new Error(`Unsupported model output shape [${dims.join(', ')}] for ${C} classes.`);
  return out;
}

/** Greedy non-maximum suppression per class. */
export function nms<T extends { confidence: number; bbox: Box; cls?: number }>(cands: T[], iou = 0.45): T[] {
  const sorted = [...cands].sort((a, b) => b.confidence - a.confidence);
  const keep: T[] = [];
  for (const c of sorted) if (!keep.some((k) => (k.cls ?? 0) === (c.cls ?? 0) && boxIoU(k.bbox, c.bbox) > iou)) keep.push(c);
  return keep;
}

export class OnnxDetector implements Detector {
  readonly name = 'onnx';
  private session?: Awaited<ReturnType<OrtLike['InferenceSession']['create']>>;
  private ort?: OrtLike;
  private loading?: Promise<void>;
  private frames = 0;
  private lastMs = 0;
  private error?: string;
  readonly classes: string[];
  readonly classMap: Record<string, DetectionType>;
  readonly include: Set<string>;
  constructor(
    private readonly cfg: OnnxConfig,
    private readonly requireFn: (id: string) => unknown = createRequire(import.meta.url),
  ) {
    this.classes = cfg.classes ?? COCO_CLASSES;
    this.classMap = cfg.classMap ?? DEFAULT_CLASS_MAP;
    this.include = new Set(cfg.include ?? Object.keys(this.classMap));
  }
  private load() {
    if (!this.loading)
      this.loading = (async () => {
        try {
          this.ort = this.requireFn(this.cfg.runtime ?? 'onnxruntime-node') as OrtLike;
        } catch (e) {
          throw new Error(`Cannot load ${this.cfg.runtime ?? 'onnxruntime-node'}: install it on the edge PC (npm i onnxruntime-node). ${e instanceof Error ? e.message : e}`);
        }
        this.session = await this.ort.InferenceSession.create(this.cfg.model, this.cfg.providers ? { executionProviders: this.cfg.providers } : undefined);
      })().catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      });
    return this.loading;
  }
  async detect(frame: Frame): Promise<Candidate[]> {
    await this.load();
    const size = this.cfg.inputSize ?? 640;
    const t0 = Date.now();
    const lb = letterbox(frame, size);
    const input = new this.ort!.Tensor('float32', lb.data, [1, 3, size, size]);
    const res = await this.session!.run({ [this.session!.inputNames[0]]: input });
    const out = res[this.session!.outputNames[0]];
    const raw = decodeYolo(out.data, out.dims, { size, scale: lb.scale, padX: lb.padX, padY: lb.padY, frameW: frame.width, frameH: frame.height, classes: this.classes, minConfidence: this.cfg.minConfidence ?? 0.35 });
    this.frames++;
    this.lastMs = Date.now() - t0;
    return nms(raw, this.cfg.iouThreshold ?? 0.45)
      .filter((c) => this.include.has(c.label!))
      .map((c) => ({ type: this.classMap[c.label!] ?? 'other', confidence: c.confidence, bbox: c.bbox, label: c.label, attributes: { label: c.label } }));
  }
  info() {
    return { model: this.cfg.model, frames: this.frames, inferenceMs: this.lastMs, error: this.error, classes: [...this.include] };
  }
}

/** A detector driven from code or a script: candidates per frame (tests, demos, external analytics). */
export class ScriptedDetector implements Detector {
  readonly name: string;
  constructor(
    private readonly fn: (frame: Frame, at: number) => Candidate[],
    name = 'scripted',
  ) {
    this.name = name;
  }
  detect(frame: Frame, at: number) {
    return this.fn(frame, at);
  }
  info() {
    return {};
  }
}
