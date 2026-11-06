// Vision on the gateway, two ways:
//  - VisionCameraAdapter: a camera the platform knows only through its pictures (NVR channel,
//    RTSP URL, snapshot URL). Appears as a CCTV device with the `analytics` capability.
//  - attachVision(): runs the same pipeline inside another camera adapter (ONVIF, SIYI) that
//    already has the frames or the camera's snapshot/RTSP URIs.
import type { AdapterDeclaration, DeviceAnalytics, StreamInfo } from '@13store/shared';
import type { Adapter, AdapterContext } from '../sdk';
import { VisionPipeline, type SourceConfig, type VisionConfig } from './pipeline';
import { FfmpegSource, type FrameSource } from './sources';

export interface VisionCameraConfig {
  deviceId: string;
  model?: string;
  /** Where the camera is on the site grid. */
  pos: { x: number; y: number };
  /** Live video on the site media server (optional; the pipeline does not need it). */
  stream?: StreamInfo;
  vision: VisionConfig;
  /** Health report interval (ms). Default 15 000. */
  healthMs?: number;
  /**
   * The vehicle whose camera this is (its video read from the site media server, for example):
   * the console draws the live boxes on that vehicle's cockpit view.
   */
  follows?: string;
}

export const VISION_VERSION = 'edge-vision 1.0';

/** Health of a pipeline as the platform wants it. */
export function analyticsOf(p: VisionPipeline, now: number): DeviceAnalytics {
  const h = p.status();
  const onnx = h.detectors.onnx as { model?: string } | undefined;
  return {
    provider: 'edge-vision',
    running: h.running,
    source: h.source,
    fps: h.fps,
    frames: h.frames,
    lastFrameAt: h.lastFrameAt,
    detections: h.detections,
    lastDetectionAt: h.lastDetectionAt,
    detectors: h.detectors,
    model: onnx?.model,
    errors: h.errors,
    lastError: h.lastError,
    updatedAt: now,
  };
}

/**
 * Runs a pipeline for an adapter: detections and health go out through its context.
 * Returns a handle to stop it. `source` overrides the configured frame source.
 */
export function attachVision(ctx: AdapterContext, cfg: VisionConfig, opts: { source?: FrameSource; healthMs?: number; label?: string } = {}) {
  const log = (m: string) => ctx.log.info(`${opts.label ?? 'vision'}: ${m}`);
  let pipeline: VisionPipeline;
  try {
    pipeline = new VisionPipeline(cfg, {
      now: () => ctx.now(),
      log,
      onDetection: (d) => {
        const { bbox, ...rest } = d;
        ctx.event({
          kind: 'detection',
          at: d.at,
          detail: `${d.type}${d.attributes?.label ? ` (${d.attributes.label})` : ''} ${Math.round((d.confidence ?? 1) * 100)}%`,
          detection: { ...rest, bbox },
        });
      },
      onBoxes: (b) => ctx.tracks?.(b),
      onError: (e) => ctx.log.warn(`${opts.label ?? 'vision'}: ${e.message}`),
    });
  } catch (e) {
    ctx.log.error(`${opts.label ?? 'vision'}: ${(e as Error).message}`);
    return undefined;
  }
  const report = () => ctx.event({ kind: 'analytics', at: ctx.now(), analytics: analyticsOf(pipeline, ctx.now()) });
  let timer: NodeJS.Timeout | undefined;
  try {
    pipeline.start(opts.source);
    timer = setInterval(report, opts.healthMs ?? 15_000);
    setTimeout(report, 1500);
    log(`started (${pipeline.detectors.map((d) => d.name).join(', ')})`);
  } catch (e) {
    ctx.log.error(`${opts.label ?? 'vision'}: ${(e as Error).message}`);
  }
  return {
    pipeline,
    report,
    stop() {
      if (timer) clearInterval(timer);
      pipeline.stop();
      report();
    },
  };
}

type FollowSource = Extract<SourceConfig, { kind: 'follow' }>;

/** Frames of the followed vehicle's video at the address the server granted (ffmpeg, 5 fps, 640 px wide). */
const followSource = (url: string, s: FollowSource): FrameSource => new FfmpegSource({ input: url, fps: s.fps ?? 5, width: s.width ?? 640, ffmpegPath: s.ffmpegPath });

export class VisionCameraAdapter implements Adapter {
  readonly declaration: AdapterDeclaration;
  private handle?: ReturnType<typeof attachVision>;
  private timer?: NodeJS.Timeout;
  private seq = 0;
  private ctx?: AdapterContext;
  /** The read address in use (camera AI that follows a vehicle). */
  private readUrl?: string;

  constructor(
    private readonly cfg: VisionCameraConfig,
    private readonly sourceFor: (url: string, s: FollowSource) => FrameSource = followSource,
  ) {
    const det = Object.keys(cfg.vision.detectors).filter((k) => (cfg.vision.detectors as Record<string, unknown>)[k]);
    this.declaration = {
      deviceId: cfg.deviceId,
      kind: 'cctv',
      model: cfg.model ?? 'IP camera (vision only)',
      adapterVersion: VISION_VERSION,
      protocolVersion: cfg.vision.source ? `${cfg.vision.source.kind} frames` : 'frames from adapter',
      firmwareTested: 'n/a (pictures only)',
      integration: 'testing',
      capabilities: ['video', 'analytics'],
      commands: [],
      units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
      rateMs: 5000,
      limitations: `Analytics only (${det.join(', ')}); no PTZ or recording control from the platform.`,
      linkLossBehavior: 'The camera keeps recording to its NVR; detections resume when the gateway reconnects.',
      stream: cfg.stream,
      ...(cfg.follows ? { follows: cfg.follows } : {}),
      components: [{ id: 'vision', name: 'Edge vision', kind: 'computer', status: 'pending', detail: det.join(', ') }],
    } as AdapterDeclaration;
  }

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    // A camera AI that follows a vehicle starts once the server grants the vehicle's video (onMediaRead).
    if (this.cfg.vision.source?.kind === 'follow') ctx.log.info(`${this.cfg.deviceId}: waiting for the server to grant the video of ${this.cfg.follows ?? 'the vehicle'}`);
    else this.handle = attachVision(ctx, this.cfg.vision, { healthMs: this.cfg.healthMs, label: this.cfg.deviceId });
    const beat = () => {
      const h = this.handle?.pipeline.status();
      const fresh = !!h?.lastFrameAt && ctx.now() - h.lastFrameAt < 30_000;
      ctx.telemetry({
        seq: this.seq++,
        sourceTime: ctx.now(),
        pos: this.cfg.pos,
        heading: 0,
        speed: 0,
        battery: 100,
        accuracyM: 0,
        signal: fresh ? 100 : 0,
        mode: fresh ? 'online' : 'no-frames',
      } as never);
    };
    beat();
    this.timer = setInterval(beat, 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.handle?.stop();
  }

  /** The followed vehicle's video, granted (again) by the server: start reading it, or switch to the new pass. */
  onMediaRead(url: string) {
    const s = this.cfg.vision.source;
    if (!this.ctx || s?.kind !== 'follow' || url === this.readUrl) return;
    this.readUrl = url;
    this.handle?.stop();
    this.handle = attachVision(this.ctx, this.cfg.vision, { source: this.sourceFor(url, s), healthMs: this.cfg.healthMs, label: this.cfg.deviceId });
  }

  onCommand() {
    /* no commands are declared */
  }

  onDemo() {
    /* real adapter */
  }
}
