// The vision pipeline for one camera: frames → detectors → image zones → tracking → rate control
// → detections for the platform (with a JPEG crop as evidence). Also keeps the health figures
// the console shows (fps, last frame, detector state).
import type { DetectionInput, DetectionType } from '@13store/shared';
import { boxIoU, cropJpeg, decodeJpeg, inPolygon, type Box, type Frame } from './frames';
import { MotionDetector, OnnxDetector, ThermalDetector, type Candidate, type Detector, type MotionConfig, type OnnxConfig, type ThermalConfig } from './detectors';
import { FfmpegSource, FolderSource, MjpegSource, SnapshotSource, type FrameSource, type HttpAuth } from './sources';

export type ZoneKind = 'protected' | 'ignore' | 'count';

export interface ImageZone {
  id: string;
  name: string;
  kind: ZoneKind;
  /** Polygon in normalised frame coordinates [[x, y], …], 0–1. */
  poly: [number, number][];
  /** For `count` zones: people at or above this number raise a crowd detection. Default 5. */
  crowdMin?: number;
  /** Site zone / place the platform should file detections from this image zone under. */
  zone?: string;
  place?: string;
  pos?: { x: number; y: number };
}

export type SourceConfig =
  | { kind: 'snapshot'; url: string; intervalMs?: number; auth?: HttpAuth }
  | { kind: 'mjpeg'; url: string; auth?: HttpAuth }
  | { kind: 'ffmpeg'; input: string; fps?: number; width?: number; ffmpegPath?: string; extraArgs?: string[] }
  | { kind: 'folder'; dir: string; intervalMs?: number };

export interface VisionConfig {
  /** Where frames come from. Omitted when the owning adapter supplies frames itself. */
  source?: SourceConfig;
  detectors: { motion?: MotionConfig | true; thermal?: ThermalConfig; onnx?: OnnxConfig };
  zones?: ImageZone[];
  /** Below this confidence a candidate is dropped. Default 0.5. */
  minConfidence?: number;
  /** A candidate must appear in this many consecutive frames before it is reported. Default 2 (1 for thermal). */
  minFrames?: number;
  /** Seconds between reports of the same type in the same image zone. Default 30. */
  cooldownS?: number;
  /** Seconds a tracked person must stay before "loitering" is reported. Default 60; 0 disables. */
  loiterS?: number;
  /** Attach a JPEG crop of the detection as evidence. Default true. */
  snapshot?: boolean;
  /** Name shown as the detection source. Default "Edge vision". */
  sourceName?: string;
  /** Default site zone/place for detections without an image zone. */
  zone?: string;
  place?: string;
  pos?: { x: number; y: number };
}

export interface VisionHealth {
  running: boolean;
  source: string;
  frames: number;
  fps: number;
  lastFrameAt?: number;
  detections: number;
  lastDetectionAt?: number;
  detectors: Record<string, Record<string, unknown>>;
  errors: number;
  lastError?: string;
  tracks: number;
}

interface Track {
  id: number;
  bbox: Box;
  firstSeen: number;
  lastSeen: number;
  frames: number;
  loiterReported: boolean;
  type: DetectionType;
  label?: string;
}

export interface Emitted extends Omit<DetectionInput, 'deviceId'> {
  bbox: Box;
}

export class VisionPipeline {
  readonly detectors: Detector[] = [];
  private source?: FrameSource;
  private tracks: Track[] = [];
  private nextTrack = 1;
  private lastReport = new Map<string, number>();
  private persist = new Map<string, number>();
  private health: VisionHealth = { running: false, source: 'none', frames: 0, fps: 0, detections: 0, detectors: {}, errors: 0, tracks: 0 };
  private frameTimes: number[] = [];
  private busy = false;
  private seq = 0;

  constructor(
    private readonly cfg: VisionConfig,
    private readonly out: { onDetection: (d: Emitted) => void; onError?: (e: Error) => void; now?: () => number; log?: (m: string) => void },
  ) {
    const d = cfg.detectors;
    if (d.motion) this.detectors.push(new MotionDetector(d.motion === true ? {} : d.motion));
    if (d.thermal) this.detectors.push(new ThermalDetector(d.thermal));
    if (d.onnx) this.detectors.push(new OnnxDetector(d.onnx));
    if (!this.detectors.length) throw new Error('vision.detectors must enable motion, thermal or onnx.');
  }

  /** Adds a detector built elsewhere (tests, vendor analytics). */
  use(d: Detector) {
    this.detectors.push(d);
    return this;
  }

  static sourceFrom(s: SourceConfig, now?: () => number): FrameSource {
    if (s.kind === 'snapshot') return SnapshotSource.url(s.url, s.intervalMs ?? 1000, s.auth, now);
    if (s.kind === 'mjpeg') return new MjpegSource(s.url, s.auth, now);
    if (s.kind === 'ffmpeg') return new FfmpegSource({ input: s.input, fps: s.fps, width: s.width, ffmpegPath: s.ffmpegPath, extraArgs: s.extraArgs }, now);
    return new FolderSource(s.dir, s.intervalMs ?? 1000, now);
  }

  /** Starts the configured source (or the one given) and processes its frames. */
  start(source?: FrameSource) {
    this.source = source ?? (this.cfg.source ? VisionPipeline.sourceFrom(this.cfg.source, this.out.now) : undefined);
    if (!this.source) throw new Error('No frame source configured.');
    this.health.running = true;
    this.health.source = this.source.kind;
    this.source.start(
      (jpeg, at) => void this.frameBytes(jpeg, at),
      (e) => this.fail(e),
    );
  }

  stop() {
    this.source?.stop();
    this.health.running = false;
  }

  private fail(e: Error) {
    this.health.errors++;
    this.health.lastError = e.message.slice(0, 200);
    this.out.onError?.(e);
  }

  /** JPEG bytes in. Frames arriving while one is being processed are dropped (keeps up on slow PCs). */
  async frameBytes(jpeg: Uint8Array, at: number) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.frame(decodeJpeg(jpeg, at), at);
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.busy = false;
    }
  }

  /** A decoded frame in. */
  async frame(frame: Frame, at: number) {
    this.health.frames++;
    this.health.lastFrameAt = at;
    this.frameTimes.push(at);
    while (this.frameTimes.length > 20) this.frameTimes.shift();
    if (this.frameTimes.length > 1)
      this.health.fps = Math.round(((this.frameTimes.length - 1) / Math.max(1, this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0])) * 1000 * 100) / 100;
    const cands: Candidate[] = [];
    for (const d of this.detectors) {
      try {
        cands.push(...(await d.detect(frame, at)));
        this.health.detectors[d.name] = d.info();
      } catch (e) {
        this.health.detectors[d.name] = { error: e instanceof Error ? e.message : String(e) };
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    }
    const minConf = this.cfg.minConfidence ?? 0.5;
    const zoned = this.applyZones(cands.filter((c) => c.confidence >= minConf));
    this.track(zoned, at);
    const all = [...zoned, ...this.crowds(zoned), ...this.loitering(at)];
    // Persistence: a key (type + image zone) must be seen in consecutive frames; absent keys reset.
    const present = new Set(all.map((c) => this.keyOf(c)));
    for (const k of this.persist.keys()) if (!present.has(k)) this.persist.set(k, 0);
    for (const k of present) this.persist.set(k, (this.persist.get(k) ?? 0) + 1);
    for (const c of all) this.consider(c, frame, at);
    this.health.tracks = this.tracks.length;
  }

  private zoneOf(c: Candidate): ImageZone | undefined {
    const [x, y, w, h] = c.bbox;
    // People stand on their feet: use the bottom centre; otherwise the box centre.
    const px = x + w / 2;
    const py = c.type === 'person' || c.type === 'intrusion' ? Math.min(1, y + h) : y + h / 2;
    return (this.cfg.zones ?? []).find((z) => inPolygon(px, py, z.poly));
  }

  private applyZones(cands: Candidate[]): (Candidate & { zone?: ImageZone })[] {
    const out: (Candidate & { zone?: ImageZone })[] = [];
    for (const c of cands) {
      const z = this.zoneOf(c);
      if (z?.kind === 'ignore') continue;
      if (z?.kind === 'protected' && (c.type === 'person' || c.type === 'vehicle' || c.type === 'motion')) {
        out.push({ ...c, type: 'intrusion', attributes: { ...c.attributes, label: c.label ?? c.type }, zone: z });
        continue;
      }
      out.push({ ...c, zone: z });
    }
    return out;
  }

  private track(cands: Candidate[], at: number) {
    const people = cands.filter((c) => c.type === 'person' || c.type === 'intrusion');
    const used = new Set<Track>();
    for (const c of people) {
      let best: Track | undefined;
      let bestIou = 0.3;
      for (const t of this.tracks) {
        if (used.has(t)) continue;
        const iou = boxIoU(t.bbox, c.bbox);
        if (iou > bestIou) {
          bestIou = iou;
          best = t;
        }
      }
      if (best) {
        best.bbox = c.bbox;
        best.lastSeen = at;
        best.frames++;
        best.type = c.type;
        used.add(best);
      } else {
        const t: Track = { id: this.nextTrack++, bbox: c.bbox, firstSeen: at, lastSeen: at, frames: 1, loiterReported: false, type: c.type, label: c.label };
        this.tracks.push(t);
        used.add(t);
      }
    }
    this.tracks = this.tracks.filter((t) => at - t.lastSeen < 5000);
  }

  private crowds(cands: (Candidate & { zone?: ImageZone })[]): (Candidate & { zone?: ImageZone })[] {
    const out: (Candidate & { zone?: ImageZone })[] = [];
    for (const z of (this.cfg.zones ?? []).filter((z) => z.kind === 'count')) {
      const inZone = cands.filter((c) => (c.type === 'person' || c.type === 'intrusion') && c.zone?.id === z.id);
      if (inZone.length >= (z.crowdMin ?? 5)) {
        const x0 = Math.min(...inZone.map((c) => c.bbox[0]));
        const y0 = Math.min(...inZone.map((c) => c.bbox[1]));
        const x1 = Math.max(...inZone.map((c) => c.bbox[0] + c.bbox[2]));
        const y1 = Math.max(...inZone.map((c) => c.bbox[1] + c.bbox[3]));
        out.push({
          type: 'crowd',
          confidence: Math.min(1, inZone.reduce((s, c) => s + c.confidence, 0) / inZone.length),
          bbox: [x0, y0, x1 - x0, y1 - y0],
          label: 'crowd',
          attributes: { count: inZone.length },
          zone: z,
        });
      }
    }
    return out;
  }

  private loitering(at: number): (Candidate & { zone?: ImageZone })[] {
    const limit = (this.cfg.loiterS ?? 60) * 1000;
    if (limit <= 0) return [];
    const out: (Candidate & { zone?: ImageZone })[] = [];
    for (const t of this.tracks) {
      if (t.loiterReported || at - t.firstSeen < limit || t.frames < 3) continue;
      // Only a report that gets through the cooldown consumes the track's one-shot flag.
      const lkey = `loitering:${this.zoneOf({ type: 'person', confidence: 1, bbox: t.bbox })?.id ?? '-'}`;
      if (at - (this.lastReport.get(lkey) ?? -Infinity) < (this.cfg.cooldownS ?? 30) * 1000) continue;
      t.loiterReported = true;
      const c: Candidate = { type: 'loitering', confidence: 0.8, bbox: t.bbox, label: 'loitering', attributes: { label: `${Math.round((at - t.firstSeen) / 1000)} s` } };
      out.push({ ...c, zone: this.zoneOf({ ...c, type: 'person' }) });
    }
    return out;
  }

  private keyOf(c: Candidate & { zone?: ImageZone }) {
    return `${c.type}:${c.zone?.id ?? '-'}`;
  }

  /** Persistence and cooldown, then emit. */
  private consider(c: Candidate & { zone?: ImageZone }, frame: Frame, at: number) {
    const key = this.keyOf(c);
    const need = c.type === 'thermal_hotspot' || c.type === 'crowd' || c.type === 'loitering' ? 1 : (this.cfg.minFrames ?? 2);
    if ((this.persist.get(key) ?? 0) < need) return;
    const last = this.lastReport.get(key) ?? -Infinity;
    if (at - last < (this.cfg.cooldownS ?? 30) * 1000) return;
    this.lastReport.set(key, at);
    this.health.detections++;
    this.health.lastDetectionAt = at;
    const snap = this.cfg.snapshot === false ? undefined : cropJpeg(frame, c.bbox, { maxSide: 640 });
    this.out.onDetection({
      type: c.type,
      confidence: Math.round(c.confidence * 100) / 100,
      at,
      source: this.cfg.sourceName ?? 'Edge vision',
      bbox: c.bbox.map((v) => Math.round(v * 1000) / 1000) as Box,
      zone: c.zone?.zone ?? this.cfg.zone,
      place: c.zone?.place ?? (c.zone ? c.zone.name : this.cfg.place),
      pos: c.zone?.pos ?? this.cfg.pos,
      attributes: c.attributes,
      snapshot: snap ? { mime: snap.mime, base64: snap.base64 } : undefined,
      externalId: `vision-${at}-${this.seq++}`,
    });
  }
  /** Health figures for the gateway's analytics report. */
  status(): VisionHealth {
    return { ...this.health, detectors: { ...this.health.detectors } };
  }
}
