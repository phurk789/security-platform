// Adapter for any ONVIF camera (Profile S/T): fixed domes, bullets, PTZ and thermal cameras from
// Hikvision, Dahua, Axis, Uniview, Bosch and others. Control and status go over ONVIF (SOAP); the
// video itself is pulled by the site media server (RTSP → WebRTC), like every other camera.
// Analytics events the camera raises (motion, intrusion, thermal, LPR …) become detections.
import type { AdapterDeclaration, CameraAction, CameraMount, GimbalState, GwCameraResult, SrvCommand, StreamInfo } from '@13store/shared';
import { ComponentTracker } from '../adapters/components';
import type { Adapter, AdapterContext } from '../sdk';
import { attachVision } from '../vision/adapter';
import { FfmpegSource, SnapshotSource } from '../vision/sources';
import { cropJpeg, decodeJpeg } from '../vision/frames';
import type { VisionConfig } from '../vision/pipeline';
import { interpretEvent, OnvifClient, OnvifError, type OnvifProfile } from './onvif';

export interface OnvifCameraConfig {
  deviceId: string;
  host: string;
  port?: number;
  tls?: boolean;
  username: string;
  password: string;
  model?: string;
  /** Where the camera is mounted on the site grid. */
  pos: { x: number; y: number };
  /** Bearing of pan 0, lens height and field of view, so the platform can point it at alerts. */
  mount?: CameraMount;
  /** Media-server stream (WHEP/HLS/playback). RTSP is discovered from the camera when omitted. */
  stream?: StreamInfo;
  /** Media profile token to use; default: the first profile (with PTZ when there is one). */
  profile?: string;
  firmwareTested?: string;
  /** false = never use PTZ even if the camera has it. */
  ptz?: boolean;
  /** Mechanical range, so ONVIF's normalised −1…1 becomes degrees: default 360° pan, 180° tilt. */
  panRangeDeg?: number;
  tiltRangeDeg?: number;
  /** Optical zoom at ONVIF zoom 1.0 (default 10×). */
  maxZoom?: number;
  /** false = do not subscribe to the camera's events. */
  events?: boolean;
  pollMs?: number;
  /** Run the edge vision pipeline on this camera's pictures (snapshot URI by default, or its RTSP stream through ffmpeg). */
  vision?: VisionConfig & { frames?: 'snapshot' | 'rtsp'; intervalMs?: number; fps?: number };
}

const RETRY_MS = 5000;
const RENEW_EVERY_MS = 45_000;

export class OnvifCameraAdapter implements Adapter {
  readonly declaration: AdapterDeclaration;
  private ctx!: AdapterContext;
  private client!: OnvifClient;
  private comps: ComponentTracker;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  private running = false;
  private connected = false;
  private lastReply = 0;
  private telSeq = 0;
  private profile?: OnvifProfile;
  private snapshotUri?: string;
  private vision?: ReturnType<typeof attachVision>;
  private ptzOk = false;
  private gimbal: GimbalState = { yaw: 0, pitch: 0, zoom: 1 };
  private eventsAbort?: { stopped: boolean };

  private get pollMs() {
    return this.cfg.pollMs ?? 1000;
  }
  private get wantPtz() {
    return this.cfg.ptz !== false;
  }

  constructor(private cfg: OnvifCameraConfig) {
    const parts = [
      { id: 'cam', name: cfg.model ?? 'ONVIF camera', kind: 'camera' as const, status: 'pending' as const, detail: 'Waiting for GetDeviceInformation' },
      ...(this.wantPtz ? [{ id: 'ptz', name: 'Pan-tilt-zoom', kind: 'gimbal' as const, status: 'pending' as const, detail: 'Waiting for the PTZ service' }] : []),
      {
        id: 'media',
        name: 'Site media server stream',
        kind: 'network' as const,
        status: 'pending' as const,
        detail: cfg.stream?.rtsp ?? 'Discovering the RTSP stream URI',
        stream: cfg.stream,
      },
      ...(cfg.events !== false
        ? [{ id: 'events', name: 'Camera analytics events', kind: 'other' as const, status: 'pending' as const, detail: 'Waiting for the event subscription' }]
        : []),
      ...(cfg.vision
        ? [{ id: 'vision', name: 'Edge vision', kind: 'computer' as const, status: 'pending' as const, detail: Object.keys(cfg.vision.detectors ?? {}).join(', ') }]
        : []),
    ];
    this.comps = new ComponentTracker(parts);
    this.declaration = {
      deviceId: cfg.deviceId,
      kind: 'cctv',
      model: cfg.model ?? 'ONVIF camera',
      adapterVersion: 'onvif 1.0',
      protocolVersion: 'ONVIF Profile S/T (SOAP 1.2, WS-UsernameToken)',
      firmwareTested: cfg.firmwareTested ?? 'not yet tested on hardware',
      integration: 'testing',
      capabilities: ['video', 'camera', 'photo', ...(this.wantPtz ? ['gimbal', 'zoom'] : [])],
      commands: [],
      units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
      rateMs: this.pollMs,
      limitations: `ONVIF at ${cfg.host}:${cfg.port ?? (cfg.tls ? 443 : 80)}. Video via the site media server. Recording is handled by the media server, not the camera.`,
      linkLossBehavior: 'The camera keeps running on its own; PTZ holds its position. Nothing is queued.',
      stream: cfg.stream,
      mount: cfg.mount,
      components: this.comps.list(),
    } as AdapterDeclaration;
  }

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.running = true;
    this.client = new OnvifClient({
      host: this.cfg.host,
      port: this.cfg.port,
      tls: this.cfg.tls,
      username: this.cfg.username,
      password: this.cfg.password,
      now: () => ctx.now(),
      timeoutMs: 4000,
    });
    this.timers.push(setInterval(() => this.emitTelemetry(), this.pollMs));
    void this.connect();
  }

  stop() {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.vision?.stop();
    this.vision = undefined;
    if (this.retry) clearTimeout(this.retry);
    if (this.eventsAbort) this.eventsAbort.stopped = true;
    this.connected = false;
  }

  onCommand(cmd: SrvCommand) {
    this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'rejected', detail: 'Cameras do not take mission commands.' });
  }

  onDemo() {
    /* real device: presenter controls do not apply */
  }

  // ---- connection ------------------------------------------------------------

  private async connect() {
    if (!this.running) return;
    try {
      const info = await this.client.getDeviceInformation();
      this.touch();
      this.comps.set('cam', {
        status: 'ok',
        version: info.firmware || undefined,
        detail: [info.manufacturer, info.model, info.serial ? `S/N ${info.serial}` : ''].filter(Boolean).join(' · ') || 'ONVIF answering',
      });
      const services = await this.client.discover();
      const profiles = await this.client.getProfiles();
      if (!profiles.length) throw new OnvifError('The camera has no media profiles.');
      this.profile = (this.cfg.profile ? profiles.find((p) => p.token === this.cfg.profile) : undefined) ?? profiles.find((p) => p.ptz) ?? profiles[0];
      if (this.cfg.profile && this.profile.token !== this.cfg.profile)
        this.ctx.log.warn(`${this.cfg.deviceId}: profile ${this.cfg.profile} not found, using ${this.profile.token}`);
      let rtsp = this.cfg.stream?.rtsp;
      try {
        rtsp = rtsp ?? (await this.client.getStreamUri(this.profile.token));
      } catch (e) {
        this.ctx.log.warn(`${this.cfg.deviceId}: GetStreamUri failed: ${(e as Error).message}`);
      }
      const res = this.profile.width ? ` ${this.profile.width}×${this.profile.height}` : '';
      this.comps.set('media', {
        status: this.cfg.stream?.whep || this.cfg.stream?.hls ? 'ok' : 'warn',
        detail: `${rtsp ?? 'no RTSP URI'}${res}${this.cfg.stream?.whep || this.cfg.stream?.hls ? '' : ' · no media-server stream configured: console shows no live video'}`,
      });
      try {
        this.snapshotUri = await this.client.getSnapshotUri(this.profile.token);
      } catch {
        this.snapshotUri = undefined;
      }
      if (!this.running) return; // stopped while the camera was answering
      if (this.cfg.vision && !this.vision) {
        try {
          this.startVision(rtsp);
        } catch (e) {
          this.ctx.log.warn(`${this.cfg.deviceId}: vision not started: ${(e as Error).message}`);
        }
      }
      if (this.wantPtz) {
        if (services.ptz && this.profile.ptz) {
          await this.pollPtz();
          this.ptzOk = true;
          this.comps.set('ptz', { status: 'ok', detail: 'PTZ status streaming' });
          this.timers.push(setInterval(() => void this.pollPtz(), this.pollMs));
        } else {
          this.ptzOk = false;
          this.comps.set('ptz', { status: 'offline', detail: services.ptz ? 'The selected profile has no PTZ configuration' : 'The camera has no PTZ service' });
        }
      }
      this.connected = true;
      this.ctx.log.info(`${this.cfg.deviceId}: ONVIF ${info.manufacturer} ${info.model} fw ${info.firmware}, profile ${this.profile.name}${this.ptzOk ? ', PTZ' : ''}`);
      if (this.cfg.events !== false) {
        if (services.events) void this.eventLoop();
        else this.comps.set('events', { status: 'offline', detail: 'The camera has no events service' });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const auth = e instanceof OnvifError && e.status === 401;
      this.comps.set('cam', { status: auth ? 'fault' : 'offline', detail: auth ? msg : `Not reachable: ${msg}` });
      this.ctx.log.warn(`${this.cfg.deviceId}: ${msg}${auth ? '' : ` (retrying in ${RETRY_MS / 1000} s)`}`);
      if (!auth) this.retry = setTimeout(() => void this.connect(), RETRY_MS);
    }
  }

  private touch() {
    this.lastReply = this.ctx.now();
  }

  private stale() {
    return !this.lastReply || this.ctx.now() - this.lastReply > Math.max(3000, 3 * this.pollMs);
  }

  private async pollPtz() {
    if (!this.profile) return;
    try {
      const st = await this.client.getStatus(this.profile.token);
      this.touch();
      this.gimbal = {
        yaw: round(st.pan * ((this.cfg.panRangeDeg ?? 360) / 2)),
        pitch: round(st.tilt * ((this.cfg.tiltRangeDeg ?? 180) / 2)),
        zoom: round(1 + Math.max(0, Math.min(1, st.zoom)) * ((this.cfg.maxZoom ?? 10) - 1)),
      };
      if (this.ptzOk) this.comps.set('ptz', { status: 'ok', detail: st.moving ? 'Moving' : 'PTZ status streaming' });
    } catch (e) {
      if (this.ptzOk) this.comps.set('ptz', { status: 'warn', detail: `GetStatus failed: ${(e as Error).message}` });
    }
  }

  private emitTelemetry() {
    if (!this.connected || this.stale()) {
      // Silence → the platform shows STALE / OFFLINE. Check the link again.
      if (this.connected && this.running && this.stale()) void this.heartbeat();
      return;
    }
    this.ctx.telemetry({
      seq: ++this.telSeq,
      sourceTime: this.lastReply,
      pos: { ...this.cfg.pos },
      accuracyM: 0.5,
      speed: 0,
      quality: 'good',
      gimbal: this.ptzOk ? { ...this.gimbal } : undefined,
      components: this.comps.flush(),
    } as Parameters<AdapterContext['telemetry']>[0]);
  }

  /** Fixed cameras without PTZ send nothing on their own: ask something cheap to prove the link. */
  private async heartbeat() {
    try {
      await this.client.getDeviceInformation();
      this.touch();
      this.comps.set('cam', { status: 'ok' });
    } catch (e) {
      this.comps.set('cam', { status: 'offline', detail: `Not reachable: ${(e as Error).message}` });
    }
  }

  // ---- events ------------------------------------------------------------------

  private async eventLoop() {
    const abort = { stopped: false };
    this.eventsAbort = abort;
    let subscription: string | undefined;
    let renewedAt = 0;
    while (this.running && !abort.stopped) {
      try {
        if (!subscription) {
          subscription = await this.client.subscribe(60);
          renewedAt = this.ctx.now();
          this.comps.set('events', { status: 'ok', detail: 'Subscribed to camera events' });
        }
        const events = await this.client.pull(subscription, 3, 20); // shorter than the client's 4 s socket timeout
        this.touch();
        for (const e of events) this.onEvent(e);
        if (this.ctx.now() - renewedAt > RENEW_EVERY_MS) {
          await this.client.renew(subscription, 60);
          renewedAt = this.ctx.now();
        }
      } catch (e) {
        if (!this.running || abort.stopped) break;
        subscription = undefined;
        this.comps.set('events', { status: 'warn', detail: `Event subscription lost: ${(e as Error).message}` });
        await sleep(RETRY_MS);
      }
    }
    if (subscription) void this.client.unsubscribe(subscription).catch(() => {});
  }

  /** Edge vision on this camera: poll its snapshot URI, or sample its RTSP stream with ffmpeg. */
  private startVision(rtsp?: string) {
    const v = this.cfg.vision!;
    const useRtsp = v.frames === 'rtsp' || (!v.frames && !this.snapshotUri && rtsp);
    let source;
    if (v.source)
      source = undefined; // the config names its own source
    else if (useRtsp && rtsp) {
      const u = new URL(rtsp);
      // Cameras often report their own (NAT'd) address: use the host we reach the camera on, like resolve() does.
      if (u.hostname !== this.cfg.host) u.hostname = this.cfg.host;
      if (!u.username) {
        u.username = encodeURIComponent(this.cfg.username);
        u.password = encodeURIComponent(this.cfg.password);
      }
      source = new FfmpegSource({ input: u.toString(), fps: v.fps ?? 1, width: 640 }, () => this.ctx.now());
    } else if (this.snapshotUri) {
      const uri = this.snapshotUri;
      source = new SnapshotSource(
        async () => (await this.client.getBytes(uri)).bytes,
        v.intervalMs ?? 1000,
        () => this.ctx.now(),
      );
    } else {
      this.ctx.log.warn(`${this.cfg.deviceId}: vision configured but the camera offers neither a snapshot URI nor RTSP`);
      return;
    }
    this.vision = attachVision(this.ctx, v, { source, label: this.cfg.deviceId });
    if (this.vision) this.comps.set('vision', { status: 'ok', detail: `Edge vision: ${Object.keys(v.detectors).join(', ')} · ${source?.kind ?? v.source?.kind}` });
  }

  private onEvent(e: Parameters<typeof interpretEvent>[0]) {
    const d = interpretEvent(e);
    if (!d || !d.active) return;
    if (d.type === 'tamper') {
      this.ctx.event({ kind: 'fault', at: e.at, detail: 'Camera tamper alarm (covered, moved or defocused).' });
      return;
    }
    const conf = Number(e.data.Confidence ?? e.data.Likelihood);
    this.ctx.event({
      kind: 'detection',
      at: e.at,
      detail: e.topic,
      detection: {
        type: d.type,
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf)) : 1,
        source: `${this.cfg.model ?? 'ONVIF camera'} analytics`,
        attributes: d.attributes,
      },
    });
  }

  // ---- camera control ------------------------------------------------------

  private reply(requestId: string, r: Omit<GwCameraResult, 't' | 'deviceId' | 'requestId'>) {
    this.ctx.cameraResult({ requestId, ...r });
  }

  onCamera(requestId: string, a: CameraAction) {
    void this.camera(requestId, a);
  }

  private async camera(requestId: string, a: CameraAction) {
    if (!this.connected || this.stale()) return this.reply(requestId, { ok: false, confirmed: false, detail: 'Camera is not responding. Command not sent.' });
    const token = this.profile!.token;
    const needPtz = ['gimbal_speed', 'gimbal_angle', 'center', 'zoom', 'zoom_to'].includes(a.action);
    if (needPtz && !this.ptzOk) return this.reply(requestId, { ok: false, confirmed: false, detail: 'This camera has no pan-tilt-zoom.' });
    try {
      switch (a.action) {
        case 'gimbal_speed':
          await this.client.continuousMove(token, a.yaw / 100, a.pitch / 100);
          this.touch();
          return this.reply(requestId, { ok: true, confirmed: true, detail: a.yaw === 0 && a.pitch === 0 ? 'Gimbal stopped.' : 'Gimbal moving.' });
        case 'gimbal_angle':
          await this.client.absoluteMove(token, { pan: a.yaw / ((this.cfg.panRangeDeg ?? 360) / 2), tilt: a.pitch / ((this.cfg.tiltRangeDeg ?? 180) / 2) });
          this.touch();
          return this.reply(requestId, { ok: true, confirmed: true, detail: `Moving to yaw ${Math.round(a.yaw)}°, pitch ${Math.round(a.pitch)}°.` });
        case 'center':
          try {
            await this.client.gotoHome(token);
          } catch {
            await this.client.absoluteMove(token, { pan: 0, tilt: 0 });
          }
          this.touch();
          return this.reply(requestId, { ok: true, confirmed: true, detail: 'Returning to the home position.' });
        case 'zoom':
          await this.client.continuousMove(token, 0, 0, a.dir * 0.5);
          this.touch();
          return this.reply(requestId, { ok: true, confirmed: true, detail: a.dir === 0 ? 'Zoom stopped.' : a.dir > 0 ? 'Zooming in.' : 'Zooming out.' });
        case 'zoom_to': {
          const z = (Math.max(1, a.level) - 1) / Math.max(1, (this.cfg.maxZoom ?? 10) - 1);
          await this.client.absoluteMove(token, { zoom: z });
          this.touch();
          return this.reply(requestId, { ok: true, confirmed: true, detail: `Zooming to ${a.level}×.` });
        }
        case 'photo': {
          if (!this.snapshotUri) return this.reply(requestId, { ok: false, confirmed: false, detail: 'The camera offers no snapshot URI.' });
          const { mime, bytes } = await this.client.getBytes(this.snapshotUri);
          this.touch();
          if (!bytes.length || !/^image\//.test(mime)) return this.reply(requestId, { ok: false, confirmed: false, detail: 'The camera returned no image.' });
          // Keep the frame under the gateway channel's 1 MB message limit.
          let frame = { mime, base64: bytes.toString('base64') };
          if (bytes.length > 600_000 && mime === 'image/jpeg') {
            const c = cropJpeg(decodeJpeg(bytes, this.ctx.now(), 40_000_000), undefined, { maxSide: 1280, quality: 80 });
            frame = { mime: c.mime, base64: c.base64 };
          }
          this.ctx.event({ kind: 'snapshot', frame });
          return this.reply(requestId, { ok: true, confirmed: true, detail: `Photo captured (${Math.round(bytes.length / 1024)} KB).` });
        }
        case 'record':
          return this.reply(requestId, { ok: false, confirmed: false, detail: 'Recording runs on the site media server, not on the camera. Use the recordings timeline.' });
        default:
          return this.reply(requestId, { ok: false, confirmed: false, detail: 'This camera does not support that action.' });
      }
    } catch (e) {
      return this.reply(requestId, { ok: false, confirmed: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
}

const round = (v: number) => Math.round(v * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
