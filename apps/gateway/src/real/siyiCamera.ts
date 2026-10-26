// Adapter for SIYI gimbal cameras (ZT30, ZR30, ZR10, ZT6, A8 mini …) on a SIYI link.
// Talks the SIYI SDK over UDP; the video itself goes through the site media server (RTSP → WebRTC).
import dgram from 'node:dgram';
import { ComponentTracker } from '../adapters/components';
import type { AdapterDeclaration, CameraAction, CameraMount, GimbalState, GwCameraResult, SrvCommand, StreamInfo } from '@13store/shared';
import type { Adapter, AdapterContext } from '../sdk';
import { CMD, SIYI_DEFAULT, decode, parseAttitude, parseCurrentZoom, parseFeedback, parseFirmware, parseGimbalInfo, req, type Frame } from './siyiProtocol';

export interface SiyiCameraConfig {
  deviceId: string;
  host?: string;
  port?: number;
  model?: string;
  zone?: string;
  /** Where the camera is mounted on the site grid (fixed mast). */
  pos: { x: number; y: number };
  stream?: StreamInfo;
  /** Firmware version you have tested this adapter against (shown in Devices). */
  firmwareTested?: string;
  /**
   * Platform convention: positive yaw = turn right (clockwise seen from above). SIYI models differ,
   * and one camera can use different signs for different SDK messages, so there are two settings:
   * - `yawSpeedSign`: speed commands (`gimbal_speed`, SDK 0x07).
   * - `yawAngleSign`: the attitude the camera reports (0x0D) and absolute angle commands
   *   (`gimbal_angle`, 0x0E).
   * Measured on an A8 mini (gimbal firmware 0.4.10, hanging mount, 2026-10-26): speed +1, angle −1.
   * Check on hardware (HARDWARE_SIYI.md test 11). `yawSign` is the older single setting and is the
   * default for both when they are not set.
   */
  yawSign?: 1 | -1;
  yawSpeedSign?: 1 | -1;
  yawAngleSign?: 1 | -1;
  /** Where the gimbal's centre points, lens height and field of view (for pointing at alerts). */
  mount?: CameraMount;
}

const STALE_MS = 3000;
const sign = (v: number | undefined): 1 | -1 => (v === -1 ? -1 : 1);

export class SiyiCameraAdapter implements Adapter {
  readonly declaration: AdapterDeclaration;
  private ctx!: AdapterContext;
  private sock?: dgram.Socket;
  private timers: ReturnType<typeof setInterval>[] = [];
  private seq = 0;
  private telSeq = 0;
  private lastReply = 0;
  private gimbal: GimbalState = { yaw: 0, pitch: 0 };
  private firmware?: string;
  private comps: ComponentTracker;
  private pending = new Map<number, { requestId: string; timer: ReturnType<typeof setTimeout>; done: (r: Omit<GwCameraResult, 't' | 'deviceId' | 'requestId'>) => void }>();
  private host: string;
  private port: number;
  private get yawSpeedSign() {
    return sign(this.cfg.yawSpeedSign ?? this.cfg.yawSign);
  }
  private get yawAngleSign() {
    return sign(this.cfg.yawAngleSign ?? this.cfg.yawSign);
  }
  private reply(r: GwCameraResult) {
    const { t: _t, deviceId: _d, ...rest } = r;
    this.ctx.cameraResult(rest);
  }

  constructor(private cfg: SiyiCameraConfig) {
    this.host = cfg.host ?? SIYI_DEFAULT.host;
    this.port = cfg.port ?? SIYI_DEFAULT.port;
    this.comps = new ComponentTracker([
      { id: 'cam', name: cfg.model ?? 'SIYI gimbal camera', kind: 'camera', status: 'pending', detail: 'Waiting for the first SDK reply', stream: cfg.stream },
      { id: 'gimbal', name: 'Gimbal', kind: 'gimbal', status: 'pending', detail: 'Waiting for attitude' },
      { id: 'media', name: 'Site media server stream', kind: 'network', status: cfg.stream ? 'pending' : 'offline', detail: cfg.stream?.rtsp ?? 'No stream configured' },
    ]);
    this.declaration = {
      deviceId: cfg.deviceId,
      kind: 'cctv',
      model: cfg.model ?? 'SIYI gimbal camera',
      adapterVersion: 'siyi-sdk 1.0',
      protocolVersion: 'SIYI Gimbal Camera SDK (UDP)',
      firmwareTested: cfg.firmwareTested ?? 'not yet tested on hardware',
      integration: 'testing',
      capabilities: ['video', 'camera', 'gimbal', 'zoom', 'photo', 'record'],
      commands: [],
      units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
      rateMs: 1000,
      limitations: `SIYI SDK at ${this.host}:${this.port}. Video via the site media server.`,
      linkLossBehavior: 'Gimbal holds its last attitude; an active recording continues to the SD card.',
      view: undefined,
      stream: cfg.stream,
      mount: cfg.mount,
      components: this.comps.list(),
    } as AdapterDeclaration;
  }

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (msg) => decode(msg).forEach((f) => this.onFrame(f)));
    sock.on('error', (e) => ctx.log.warn(`${this.cfg.deviceId}: UDP error ${e.message}`));
    sock.bind(0);
    const send = (b: Buffer) => sock.send(b, this.port, this.host);
    this.timers.push(
      setInterval(() => send(req.attitude(this.nextSeq())), 500),
      setInterval(() => {
        send(req.currentZoom(this.nextSeq()));
        send(req.gimbalInfo(this.nextSeq()));
        if (!this.firmware) send(req.firmware(this.nextSeq()));
      }, 2000),
      setInterval(() => this.emitTelemetry(), 1000),
    );
    // Ask for everything once at start so the first telemetry is complete.
    send(req.firmware(this.nextSeq()));
    send(req.currentZoom(this.nextSeq()));
    send(req.gimbalInfo(this.nextSeq()));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.sock?.close();
    this.sock = undefined;
  }

  onCommand(cmd: SrvCommand) {
    // A fixed camera has no mission commands; the server never sends any (commands: []).
    this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'rejected', detail: 'Cameras do not take mission commands.' });
  }

  onDemo() {
    /* real device: presenter controls do not apply */
  }

  private nextSeq() {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  private emitTelemetry() {
    const now = this.ctx.now();
    if (!this.lastReply || now - this.lastReply > STALE_MS) return; // silence → platform shows STALE/OFFLINE
    this.ctx.telemetry({
      seq: ++this.telSeq,
      sourceTime: this.lastReply,
      pos: { ...this.cfg.pos },
      accuracyM: 0.5,
      speed: 0,
      quality: 'good',
      gimbal: { ...this.gimbal },
      components: this.comps.flush(),
    } as Parameters<AdapterContext['telemetry']>[0]);
  }

  private onFrame(f: Frame) {
    this.lastReply = this.ctx.now();
    switch (f.cmd) {
      case CMD.GIMBAL_ATTITUDE: {
        const a = parseAttitude(f.data);
        if (a) {
          Object.assign(this.gimbal, { yaw: a.yaw * this.yawAngleSign, pitch: a.pitch, roll: a.roll });
          this.comps.set('gimbal', { status: 'ok', detail: 'Attitude streaming' });
        }
        break;
      }
      case CMD.CURRENT_ZOOM:
      case CMD.ABSOLUTE_ZOOM: {
        const z = f.cmd === CMD.CURRENT_ZOOM ? parseCurrentZoom(f.data) : f.data.length >= 2 ? f.data.readUInt16LE(0) / 10 : null;
        if (z) this.gimbal.zoom = z;
        break;
      }
      case CMD.GIMBAL_INFO: {
        const g = parseGimbalInfo(f.data);
        if (g) this.gimbal.recording = g.recording;
        break;
      }
      case CMD.FIRMWARE: {
        const fw = parseFirmware(f.data);
        if (fw) {
          this.firmware = `camera ${fw.camera} · gimbal ${fw.gimbal}${fw.zoom ? ` · zoom ${fw.zoom}` : ''}`;
          this.ctx.log.info(`${this.cfg.deviceId}: firmware ${this.firmware}`);
          this.comps.set('cam', { status: 'ok', version: this.firmware, detail: 'SDK answering' });
          if (this.cfg.stream) this.comps.set('media', { status: 'ok', detail: 'Stream path registered on the media server' });
        }
        break;
      }
      case CMD.FUNCTION_FEEDBACK: {
        const code = parseFeedback(f.data);
        const p = this.pending.get(CMD.PHOTO_VIDEO);
        if (p && code !== null) {
          const ok = code === 0 || code === 2 || code === 3;
          p.done({
            ok,
            confirmed: true,
            detail: ['Photo taken.', 'Photo failed on the camera.', 'HDR on.', 'HDR off.', 'Recording failed on the camera.'][code] ?? `Camera code ${code}`,
          });
        }
        break;
      }
    }
    // Any reply carrying the same command id confirms a pending control request.
    const p = this.pending.get(f.cmd);
    if (p && f.cmd !== CMD.PHOTO_VIDEO) p.done({ ok: true, confirmed: true });
  }

  /** Camera control from the platform. Result comes back through `reply`. */
  onCamera(requestId: string, a: CameraAction) {
    const send = (b: Buffer) => this.sock?.send(b, this.port, this.host);
    const now = this.ctx.now();
    if (!this.lastReply || now - this.lastReply > STALE_MS) {
      this.reply({ t: 'camera_result', requestId, deviceId: this.cfg.deviceId, ok: false, confirmed: false, detail: 'Camera is not responding. Command not sent.' });
      return;
    }
    let cmd: number;
    let frame: Buffer;
    switch (a.action) {
      case 'gimbal_speed':
        cmd = CMD.GIMBAL_SPEED;
        frame = req.gimbalSpeed(a.yaw * this.yawSpeedSign, a.pitch, this.nextSeq());
        break;
      case 'gimbal_angle':
        cmd = CMD.SET_ATTITUDE;
        frame = req.setAttitude(a.yaw * this.yawAngleSign, a.pitch, this.nextSeq());
        break;
      case 'center':
        cmd = CMD.CENTER;
        frame = req.center(this.nextSeq());
        break;
      case 'zoom':
        cmd = CMD.MANUAL_ZOOM;
        frame = req.manualZoom(a.dir, this.nextSeq());
        break;
      case 'zoom_to':
        cmd = CMD.ABSOLUTE_ZOOM;
        frame = req.absoluteZoom(a.level, this.nextSeq());
        break;
      case 'photo':
        cmd = CMD.PHOTO_VIDEO;
        frame = req.photo(this.nextSeq());
        break;
      case 'record':
        cmd = CMD.PHOTO_VIDEO;
        frame = req.recordToggle(this.nextSeq());
        break;
      default:
        this.reply({ t: 'camera_result', requestId, deviceId: this.cfg.deviceId, ok: false, confirmed: false, detail: 'Unknown camera action.' });
        return;
    }
    this.pending.get(cmd)?.done({ ok: true, confirmed: false, detail: 'Superseded by a newer request.' });
    const timer = setTimeout(() => {
      // No reply: the frame went out but the camera did not confirm. Say so — never claim success.
      entry.done({ ok: true, confirmed: false, detail: 'Sent. The camera did not confirm.' });
    }, 1500);
    const entry = {
      requestId,
      timer,
      done: (r: Omit<GwCameraResult, 't' | 'deviceId' | 'requestId'>) => {
        clearTimeout(timer);
        if (this.pending.get(cmd) === entry) this.pending.delete(cmd);
        this.reply({ t: 'camera_result', requestId, deviceId: this.cfg.deviceId, ...r });
      },
    };
    this.pending.set(cmd, entry);
    send(frame);
  }
}
