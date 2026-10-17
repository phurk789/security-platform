// Vision on the gateway, two ways:
//  - VisionCameraAdapter: a camera the platform knows only through its pictures (NVR channel,
//    RTSP URL, snapshot URL). Appears as a CCTV device with the `analytics` capability.
//  - attachVision(): runs the same pipeline inside another camera adapter (ONVIF, SIYI) that
//    already has the frames or the camera's snapshot/RTSP URIs.
import type { AdapterDeclaration, DeviceAnalytics, StreamInfo } from '@13store/shared';
import type { Adapter, AdapterContext } from '../sdk';
import { VisionPipeline, type VisionConfig } from './pipeline';
import type { FrameSource } from './sources';

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
  const pipeline = new VisionPipeline(cfg, {
    now: () => ctx.now(),
    log,
    onDetection: (d) => {
      const { bbox, ...rest } = d;
      ctx.event({ kind: 'detection', at: d.at, detail: `${d.type}${d.attributes?.label ? ` (${d.attributes.label})` : ''} ${Math.round((d.confidence ?? 1) * 100)}%`, detection: { ...rest, bbox } });
    },
    onError: (e) => ctx.log.warn(`${opts.label ?? 'vision'}: ${e.message}`),
  });
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

export class VisionCameraAdapter implements Adapter {
  readonly declaration: AdapterDeclaration;
  private handle?: ReturnType<typeof attachVision>;
  private timer?: NodeJS.Timeout;
  private seq = 0;

  constructor(private readonly cfg: VisionCameraConfig) {
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
      components: [{ id: 'vision', name: 'Edge vision', kind: 'computer', status: 'pending', detail: det.join(', ') }],
    } as AdapterDeclaration;
  }

  start(ctx: AdapterContext) {
    this.handle = attachVision(ctx, this.cfg.vision, { healthMs: this.cfg.healthMs, label: this.cfg.deviceId });
    const beat = () => {
      const h = this.handle?.pipeline.status();
      const fresh = !!h?.lastFrameAt && ctx.now() - h.lastFrameAt < 30_000;
      ctx.telemetry({ seq: this.seq++, sourceTime: ctx.now(), pos: this.cfg.pos, heading: 0, speed: 0, battery: 100, accuracyM: 0, signal: fresh ? 100 : 0, mode: fresh ? 'online' : 'no-frames' } as never);
    };
    beat();
    this.timer = setInterval(beat, 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.handle?.stop();
  }

  onCommand() {
    /* no commands are declared */
  }

  onDemo() {
    /* real adapter */
  }
}
