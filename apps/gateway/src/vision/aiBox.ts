// AI box: the gateway analyses other devices' video when the server hands it jobs.
// A Jetson next to the server runs one gateway in this mode with its GPU model behind the http
// detector. It needs no device of its own: people switch AI on for a vehicle in the console, the
// server sends this box the vehicle's id and a read pass for its video, and the box runs one vision
// pipeline per job. Detections, live boxes and health go back under the vehicle's id.
import type { AiBoxOffer, AiJob } from '@13store/shared';
import type { AdapterContext } from '../sdk';
import { attachVision } from './adapter';
import type { VisionConfig } from './pipeline';
import { FfmpegSource, type FrameSource } from './sources';

export interface AiBoxConfig {
  /** Most videos analysed at the same time. Default 2. */
  capacity?: number;
  /** Shown to people with the switch, e.g. "YOLOv8s · TensorRT FP16 · Jetson Orin NX". */
  model?: string;
  /** Frames per second and width read from each video (ffmpeg). Defaults 5 fps, 640 px. */
  fps?: number;
  width?: number;
  ffmpegPath?: string;
  /** The pipeline run on every video. Its source is always the server's read pass. */
  vision: Omit<VisionConfig, 'source'>;
  /** Health report interval per job (ms). Default 5 000. */
  healthMs?: number;
}

/** What a job needs from the gateway: send messages under the job's device id. */
export type JobContext = Pick<AdapterContext, 'now' | 'log' | 'event' | 'tracks'>;

interface Running {
  read: string;
  handle?: ReturnType<typeof attachVision>;
}

export class AiBox {
  private jobs = new Map<string, Running>();

  constructor(
    private readonly cfg: AiBoxConfig,
    private readonly contextFor: (deviceId: string) => JobContext,
    private readonly sourceFor: (url: string) => FrameSource = (url) => new FfmpegSource({ input: url, fps: cfg.fps ?? 5, width: cfg.width ?? 640, ffmpegPath: cfg.ffmpegPath }),
  ) {}

  /** Sent in the gateway's hello. */
  get offer(): AiBoxOffer {
    return { capacity: this.cfg.capacity ?? 2, ...(this.cfg.model ? { model: this.cfg.model } : {}) };
  }

  /** Is this device one of the box's jobs (its messages may go to the server)? */
  has(deviceId: string) {
    return this.jobs.has(deviceId);
  }

  /** Device ids being analysed now. */
  active(): string[] {
    return [...this.jobs.keys()];
  }

  /**
   * The server's full list of jobs: start the new ones, stop those no longer listed, and restart
   * a job whose read pass changed (renewed, or the video moved).
   */
  setJobs(jobs: AiJob[], log: JobContext['log']) {
    const wanted = new Map(jobs.filter((j) => j && typeof j.deviceId === 'string' && typeof j.read === 'string').map((j) => [j.deviceId, j.read]));
    for (const [id, run] of [...this.jobs]) {
      if (wanted.get(id) === run.read) continue;
      this.stopJob(id, run);
      if (!wanted.has(id)) log.info(`AI box: stopped ${id}`);
    }
    for (const [id, read] of wanted) {
      if (this.jobs.has(id)) continue;
      const ctx = this.contextFor(id);
      const handle = attachVision(ctx, { ...this.cfg.vision, source: undefined }, { source: this.sourceFor(read), healthMs: this.cfg.healthMs ?? 5_000, label: `AI ${id}` });
      this.jobs.set(id, { read, handle });
      log.info(`AI box: analysing ${id}`);
    }
  }

  stopAll() {
    for (const [id, run] of [...this.jobs]) this.stopJob(id, run);
  }

  private stopJob(id: string, run: Running) {
    run.handle?.stop();
    // Clear the boxes on screen straight away (while the job is still listed, so it is sent).
    const ctx = this.contextFor(id);
    ctx.tracks?.({ at: ctx.now(), boxes: [] });
    this.jobs.delete(id);
  }
}

/** Checks an aiBox section of a site config; returns the problem in words, or undefined. */
export function aiBoxProblem(raw: unknown): string | undefined {
  const c = raw as Partial<AiBoxConfig> | undefined;
  if (!c || typeof c !== 'object') return 'aiBox must be an object.';
  if (c.capacity !== undefined && (!Number.isInteger(c.capacity) || c.capacity < 1 || c.capacity > 16)) return 'aiBox.capacity must be a whole number from 1 to 16.';
  if (c.fps !== undefined && (!Number.isFinite(c.fps) || c.fps <= 0 || c.fps > 30)) return 'aiBox.fps must be between 0 and 30.';
  if (c.width !== undefined && (!Number.isInteger(c.width) || c.width < 160 || c.width > 3840)) return 'aiBox.width must be 160–3840 pixels.';
  if (!c.vision || typeof c.vision !== 'object') return 'aiBox.vision (detectors, zones…) is required.';
  if ((c.vision as { source?: unknown }).source !== undefined) return 'aiBox.vision has no source: the server gives each job its video.';
  if (!c.vision.detectors || !Object.values(c.vision.detectors).some(Boolean)) return 'aiBox.vision.detectors must enable motion, thermal, onnx or http.';
  return undefined;
}

/** For people reading the gateway's startup line, e.g. "AI box (up to 3 videos; http)". */
export function describeAiBox(c: AiBoxConfig): string {
  const det = Object.keys(c.vision.detectors).filter((k) => (c.vision.detectors as Record<string, unknown>)[k]);
  return `AI box (up to ${c.capacity ?? 2} videos; ${det.join(', ')})`;
}
