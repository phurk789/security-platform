// Adapter for a MAVLink vehicle — e.g. a UGV or UAV on a SIYI UniFC 6 Pico (PX4 or ArduPilot),
// reached through a SIYI UniRC 7 / 7 Pro datalink (UDP, default 192.168.144.20:19856)
// or directly over the flight controller's Ethernet port.
//
// Safety rules (PRD §8):
//  • The flight controller owns motion and failsafes (FS_* / NAV_* parameters). The platform only
//    uploads an approved route and asks for AUTO / pause / hold.
//  • Remote arming is OFF by default: the pilot arms on the remote after the pre-op check.
//  • A command is confirmed only when telemetry shows the effect (moving, or stopped).
//  • Mode changes made on the remote (manual override) are reported, never fought.
import dgram from 'node:dgram';
import { PassThrough } from 'node:stream';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, ardupilotmega, common, minimal, type MavLinkPacket } from 'node-mavlink';
import { geoToSite, headingToSite, siteToGeo, type AdapterDeclaration, type GeoAnchor, type Point, type SrvCommand } from '@13store/shared';
import { CommandLedger, admitCommand, type Adapter, type AdapterContext } from '../sdk';

export type VehicleProfile = 'ardupilot-rover' | 'ardupilot-copter' | 'px4-rover' | 'px4-multicopter';

export interface MavlinkVehicleConfig {
  deviceId: string;
  kind: 'ugv' | 'uav';
  profile: VehicleProfile;
  model?: string;
  /** client: send to the datalink's UDP server (UniRC 7 Pro). listen: wait for the vehicle to send to us. */
  link: { mode: 'client'; host: string; port: number } | { mode: 'listen'; port: number };
  geo: GeoAnchor;
  /** Mission altitude above home for UAVs (m). */
  missionAltM?: number;
  /** Allow the platform to arm the vehicle. Default false — arm on the remote. */
  allowRemoteArm?: boolean;
  firmwareTested?: string;
  gcsSystemId?: number;
}

/** UniRC 7 / 7 Pro datalink UDP server (SIYI manual: QGroundControl "server address"). */
export const UNIRC7_DATALINK = { host: '192.168.144.20', port: 19856 };

const REGISTRY = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY };

// MAVLink ids (common.xml)
const MSG = { HEARTBEAT: 0, SYS_STATUS: 1, GPS_RAW_INT: 24, GLOBAL_POSITION_INT: 33, MISSION_REQUEST: 40, MISSION_CURRENT: 42, MISSION_ITEM_REACHED: 46, MISSION_ACK: 47, MISSION_REQUEST_INT: 51, VFR_HUD: 74, COMMAND_ACK: 77, RADIO_STATUS: 109, STATUSTEXT: 253 };
const CMD = { NAV_WAYPOINT: 16, DO_SET_MODE: 176, DO_PAUSE_CONTINUE: 193, MISSION_START: 300, COMPONENT_ARM_DISARM: 400, SET_MESSAGE_INTERVAL: 511 };
const FRAME_GLOBAL_RELATIVE_ALT_INT = 6;
const MAV_MODE_FLAG_SAFETY_ARMED = 128;
const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1;
const LINK_STALE_MS = 3000;

/** Flight-mode numbers per autopilot. */
const MODES: Record<VehicleProfile, { auto: number[]; hold: number[]; manual: number[]; failsafe: number[]; name: (m: number) => string }> = {
  'ardupilot-rover': {
    auto: [10],
    hold: [4],
    manual: [0, 1, 3],
    failsafe: [4, 11, 12],
    name: (m) => ({ 0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED' })[m] ?? `mode ${m}`,
  },
  'ardupilot-copter': {
    auto: [3],
    hold: [5, 17],
    manual: [0, 2, 16],
    failsafe: [6, 9, 21],
    name: (m) => ({ 0: 'STABILIZE', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 9: 'LAND', 16: 'POSHOLD', 17: 'BRAKE', 21: 'SMART_RTL' })[m] ?? `mode ${m}`,
  },
  // PX4 custom_mode = main_mode << 16 | sub_mode << 24
  'px4-rover': px4Modes(),
  'px4-multicopter': px4Modes(),
};

function px4(main: number, sub = 0) {
  return (main << 16) | (sub << 24);
}
function px4Modes() {
  return {
    auto: [px4(4, 4)], // AUTO.MISSION
    hold: [px4(4, 3)], // AUTO.LOITER (hold)
    manual: [px4(1), px4(2), px4(3), px4(5), px4(7)], // MANUAL, ALTCTL, POSCTL, ACRO, STABILIZED
    failsafe: [px4(4, 5), px4(4, 6), px4(4, 2)], // RTL, LAND, TAKEOFF guard
    name: (m: number) => {
      const main = (m >> 16) & 0xff;
      const sub = (m >> 24) & 0xff;
      const mains: Record<number, string> = { 1: 'MANUAL', 2: 'ALTCTL', 3: 'POSCTL', 4: 'AUTO', 5: 'ACRO', 6: 'OFFBOARD', 7: 'STABILIZED' };
      const subs: Record<number, string> = { 2: 'TAKEOFF', 3: 'LOITER', 4: 'MISSION', 5: 'RTL', 6: 'LAND' };
      return main === 4 ? `AUTO.${subs[sub] ?? sub}` : (mains[main] ?? `mode ${m}`);
    },
  };
}

interface Pending {
  resolve: (ok: boolean, detail?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MavlinkVehicleAdapter implements Adapter {
  readonly declaration: AdapterDeclaration;
  private ctx!: AdapterContext;
  private sock?: dgram.Socket;
  private peer?: { host: string; port: number };
  private proto: MavLinkProtocolV2;
  private txSeq = 0;
  private telSeq = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private ledger = new CommandLedger();
  private input = new PassThrough();
  private ackWaiters = new Map<number, Pending>();
  private missionWaiter: { items: ReturnType<MavlinkVehicleAdapter['buildMission']>; done: Pending } | null = null;

  // vehicle state
  private sys = 0;
  private comp = 0;
  private lastHeartbeat = 0;
  private armed = false;
  private mode = -1;
  private pos?: Point;
  private altM = 0;
  private headingDeg?: number;
  private speed = 0;
  private battery?: number;
  private satellites?: number;
  private accuracyM = 5;
  private signal?: number;
  private missionOffset = 0;
  private missionLength = 0;
  private nextCp = 0;
  private activeStart: { cmd: SrvCommand; commandId: string; since: number } | null = null;
  private activeStop: { commandId: string; type: 'pause' | 'stop' } | null = null;
  private activeResume: { commandId: string; since: number } | null = null;
  private expectMode: number | null = null;
  private wasStale = false;
  private lastTel = 0;

  constructor(private cfg: MavlinkVehicleConfig) {
    this.proto = new MavLinkProtocolV2(cfg.gcsSystemId ?? 255, 190);
    const uav = cfg.kind === 'uav';
    this.declaration = {
      deviceId: cfg.deviceId,
      kind: cfg.kind,
      model: cfg.model ?? (uav ? 'MAVLink multicopter' : 'MAVLink rover'),
      adapterVersion: 'mavlink-vehicle 1.0',
      protocolVersion: `MAVLink 2 · ${cfg.profile}`,
      firmwareTested: cfg.firmwareTested ?? 'not yet tested on hardware',
      integration: 'testing',
      capabilities: uav ? ['camera', 'overwatch', 'waypoints'] : ['camera', 'ground_patrol', 'waypoints'],
      commands: ['start', 'pause', 'resume', 'stop'],
      units: { position: 'site-m', altitude: 'm-site-datum', speed: 'm/s', battery: 'percent' },
      rateMs: 1000,
      limitations: `Flight controller via ${cfg.link.mode === 'client' ? `${cfg.link.host}:${cfg.link.port}` : `UDP :${cfg.link.port}`}. ${cfg.allowRemoteArm ? 'Remote arming enabled.' : 'Arm on the remote; the platform will not arm.'}`,
      linkLossBehavior: uav ? 'Flight controller GCS failsafe (e.g. FS_GCS_ENABLE / NAV_DLL_ACT): RTL or loiter as configured on the vehicle.' : 'Flight controller GCS failsafe (e.g. FS_GCS_ENABLE, FS_ACTION=Hold): stop in place as configured on the vehicle.',
    };
  }

  // ---- lifecycle ---------------------------------------------------------------

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    const stream = this.input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
    stream.on('data', (p: MavLinkPacket) => this.onPacket(p));
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (msg, rinfo) => {
      if (this.cfg.link.mode === 'listen') this.peer = { host: rinfo.address, port: rinfo.port };
      this.input.write(msg);
    });
    sock.on('error', (e) => ctx.log.warn(`${this.cfg.deviceId}: UDP error ${e.message}`));
    if (this.cfg.link.mode === 'client') {
      this.peer = { host: this.cfg.link.host, port: this.cfg.link.port };
      sock.bind(0);
    } else sock.bind(this.cfg.link.port);
    this.timers.push(
      setInterval(() => this.sendGcsHeartbeat(), 1000),
      setInterval(() => this.tick(), 250),
    );
    this.sendGcsHeartbeat();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.sock?.close();
    this.sock = undefined;
  }

  onDemo() {
    /* real vehicle: presenter controls never touch it */
  }

  // ---- transport -----------------------------------------------------------------

  private send(msg: InstanceType<(typeof REGISTRY)[number]>) {
    if (!this.sock || !this.peer) return;
    const buf = this.proto.serialize(msg, this.txSeq++ & 0xff);
    this.sock.send(buf, this.peer.port, this.peer.host);
  }

  private sendGcsHeartbeat() {
    const hb = new minimal.Heartbeat();
    hb.type = 6 as never; // MAV_TYPE_GCS
    hb.autopilot = 8 as never; // MAV_AUTOPILOT_INVALID
    hb.baseMode = 0 as never;
    hb.customMode = 0;
    hb.systemStatus = 4 as never; // ACTIVE
    hb.mavlinkVersion = 3;
    this.send(hb);
  }

  private commandLong(command: number, p: number[] = []) {
    const c = new common.CommandLong();
    c.targetSystem = this.sys;
    c.targetComponent = this.comp;
    c.command = command as never;
    c.confirmation = 0;
    [c._param1, c._param2, c._param3, c._param4, c._param5, c._param6, c._param7] = [0, 1, 2, 3, 4, 5, 6].map((i) => p[i] ?? 0);
    this.send(c);
  }

  /** Send a COMMAND_LONG and wait for its COMMAND_ACK. */
  private command(command: number, p: number[] = [], timeoutMs = 2500): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      this.ackWaiters.get(command)?.resolve(false, 'superseded');
      const timer = setTimeout(() => {
        this.ackWaiters.delete(command);
        resolve({ ok: false, detail: `No COMMAND_ACK for ${command}` });
      }, timeoutMs);
      this.ackWaiters.set(command, { timer, resolve: (ok, detail) => resolve({ ok, detail }) });
      this.commandLong(command, p);
    });
  }

  private requestStreams() {
    for (const id of [MSG.GLOBAL_POSITION_INT, MSG.SYS_STATUS, MSG.GPS_RAW_INT, MSG.VFR_HUD, MSG.MISSION_CURRENT, MSG.RADIO_STATUS]) {
      this.commandLong(CMD.SET_MESSAGE_INTERVAL, [id, 1_000_000]);
    }
  }

  // ---- incoming ---------------------------------------------------------------------

  private onPacket(p: MavLinkPacket) {
    const clazz = REGISTRY[p.header.msgid];
    if (!clazz) return;
    // Ignore other GCSs and the radio itself; follow the first autopilot we see.
    if (p.header.msgid === MSG.HEARTBEAT) {
      const hb = p.protocol.data(p.payload, clazz) as minimal.Heartbeat;
      if ((hb.type as number) === 6 || (hb.autopilot as number) === 8) return; // a GCS or non-autopilot
      if (!this.sys) {
        this.sys = p.header.sysid;
        this.comp = p.header.compid;
        this.ctx.log.info(`${this.cfg.deviceId}: vehicle found (sys ${this.sys}, ${(hb.autopilot as number) === 12 ? 'PX4' : (hb.autopilot as number) === 3 ? 'ArduPilot' : `autopilot ${hb.autopilot}`})`);
        this.requestStreams();
      }
      if (p.header.sysid !== this.sys) return;
      const now = this.ctx.now();
      if (this.wasStale && this.lastHeartbeat) this.onReconnect(hb.customMode);
      this.wasStale = false;
      this.lastHeartbeat = now;
      this.armed = ((hb.baseMode as number) & MAV_MODE_FLAG_SAFETY_ARMED) !== 0;
      this.onMode(hb.customMode);
      return;
    }
    if (!this.sys || p.header.sysid !== this.sys) return;
    const data = p.protocol.data(p.payload, clazz) as unknown as Record<string, number | string>;
    switch (p.header.msgid) {
      case MSG.GLOBAL_POSITION_INT: {
        const g = geoToSite(this.cfg.geo, { lat: (data.lat as number) / 1e7, lon: (data.lon as number) / 1e7 });
        this.pos = g;
        this.altM = (data.relativeAlt as number) / 1000;
        if ((data.hdg as number) !== 65535) this.headingDeg = headingToSite(this.cfg.geo, (data.hdg as number) / 100);
        this.speed = Math.hypot(data.vx as number, data.vy as number) / 100;
        break;
      }
      case MSG.VFR_HUD:
        this.speed = data.groundspeed as number;
        break;
      case MSG.SYS_STATUS:
        if ((data.batteryRemaining as number) >= 0) this.battery = data.batteryRemaining as number;
        break;
      case MSG.GPS_RAW_INT: {
        this.satellites = data.satellitesVisible as number;
        const hAcc = (data.hAcc as number) ?? 0;
        const eph = data.eph as number;
        this.accuracyM = hAcc > 0 ? hAcc / 1000 : eph && eph !== 65535 ? (eph / 100) * 2.5 : 5;
        break;
      }
      case MSG.RADIO_STATUS:
        if ((data.rssi as number) !== 255) this.signal = Math.round(((data.rssi as number) / 254) * 100);
        break;
      case MSG.MISSION_CURRENT:
        this.nextCp = Math.max(0, Math.min(this.missionLength, (data.seq as number) - this.missionOffset));
        break;
      case MSG.MISSION_ITEM_REACHED: {
        const idx = (data.seq as number) - this.missionOffset;
        if (idx >= 0 && idx < this.missionLength) {
          this.ctx.event({ kind: 'checkpoint', checkpoint: idx });
          this.nextCp = idx + 1;
          if (idx === this.missionLength - 1) this.ctx.event({ kind: 'route_complete' });
        }
        break;
      }
      case MSG.COMMAND_ACK: {
        const w = this.ackWaiters.get(data.command as number);
        if (!w) break;
        const result = data.result as number; // 0 ACCEPTED, 5 IN_PROGRESS
        if (result === 5) break;
        clearTimeout(w.timer);
        this.ackWaiters.delete(data.command as number);
        w.resolve(result === 0, result === 0 ? undefined : `Vehicle refused (MAV_RESULT ${result})`);
        break;
      }
      case MSG.MISSION_REQUEST_INT:
      case MSG.MISSION_REQUEST: {
        const m = this.missionWaiter;
        if (!m) break;
        const item = m.items[data.seq as number];
        if (item) this.send(item);
        break;
      }
      case MSG.MISSION_ACK: {
        const m = this.missionWaiter;
        if (!m) break;
        this.missionWaiter = null;
        clearTimeout(m.done.timer);
        m.done.resolve((data.type as number) === 0, (data.type as number) === 0 ? undefined : `Mission upload refused (MAV_MISSION_RESULT ${data.type})`);
        break;
      }
      case MSG.STATUSTEXT: {
        const sev = data.severity as number;
        if (sev <= 3) this.ctx.event({ kind: 'fault', detail: String(data.text).replace(/\0/g, '') });
        break;
      }
    }
  }

  private onMode(mode: number) {
    const prev = this.mode;
    this.mode = mode;
    if (prev === -1 || prev === mode) return;
    const M = MODES[this.cfg.profile];
    // Someone changed mode on the remote while we were running a route: report the override.
    if (this.expectMode !== mode && (M.manual.includes(mode) || M.failsafe.includes(mode)) && (this.activeStart || this.missionLength)) {
      this.ctx.event({ kind: 'fault', detail: `Mode changed to ${M.name(mode)} outside the platform (remote override or failsafe). The platform will not change it back.` });
    }
  }

  private onReconnect(mode: number) {
    const M = MODES[this.cfg.profile];
    if (M.failsafe.includes(mode) || M.hold.includes(mode)) {
      this.ctx.event({ kind: 'failsafe_stop', detail: `Vehicle reports ${M.name(mode)} after the link came back.` });
    }
  }

  // ---- periodic -----------------------------------------------------------------------

  private tick() {
    const now = this.ctx.now();
    const fresh = this.lastHeartbeat && now - this.lastHeartbeat < LINK_STALE_MS;
    if (!fresh) {
      this.wasStale = true;
      return; // no telemetry → the platform shows STALE, then OFFLINE
    }
    if (now - this.lastTel >= 1000) {
      this.lastTel = now;
      if (this.pos) {
        this.ctx.telemetry({
          seq: ++this.telSeq,
          sourceTime: this.lastHeartbeat,
          pos: { ...this.pos },
          alt: this.cfg.kind === 'uav' ? this.altM : undefined,
          accuracyM: Math.round(this.accuracyM * 10) / 10,
          battery: this.battery,
          speed: Math.round(this.speed * 10) / 10,
          quality: this.accuracyM < 3 ? 'good' : 'degraded',
          nextCp: this.missionLength ? this.nextCp : undefined,
          heading: this.headingDeg,
          signal: this.signal,
          satellites: this.satellites,
        } as Parameters<AdapterContext['telemetry']>[0]);
      }
    }
    const M = MODES[this.cfg.profile];
    // Confirm effects from telemetry, never from the request alone.
    if (this.activeStart && M.auto.includes(this.mode) && this.armed && (this.speed > 0.3 || now - this.activeStart.since > 3000)) {
      this.ctx.commandUpdate({ commandId: this.activeStart.commandId, status: 'succeeded' });
      this.ledger.record(this.activeStart.cmd, 'succeeded');
      this.activeStart = null;
    }
    if (this.activeResume && M.auto.includes(this.mode) && (this.speed > 0.3 || now - this.activeResume.since > 3000)) {
      this.ctx.commandUpdate({ commandId: this.activeResume.commandId, status: 'succeeded' });
      this.activeResume = null;
    }
    if (this.activeStop && this.speed < 0.2) {
      this.ctx.commandUpdate({ commandId: this.activeStop.commandId, status: 'succeeded', detail: 'Vehicle reports speed 0.' });
      if (this.activeStop.type === 'stop') this.missionLength = 0;
      this.activeStop = null;
    }
  }

  // ---- commands ---------------------------------------------------------------------------

  private buildMission(route: Point[]) {
    const ardu = this.cfg.profile.startsWith('ardupilot');
    const alt = this.cfg.kind === 'uav' ? (this.cfg.missionAltM ?? 30) : 0;
    const pts = ardu ? [this.pos ?? route[0], ...route] : route; // ArduPilot: item 0 is home
    this.missionOffset = ardu ? 1 : 0;
    return pts.map((p, seq) => {
      const g = siteToGeo(this.cfg.geo, p);
      const it = new common.MissionItemInt();
      it.targetSystem = this.sys;
      it.targetComponent = this.comp;
      it.seq = seq;
      it.frame = FRAME_GLOBAL_RELATIVE_ALT_INT as never;
      it.command = CMD.NAV_WAYPOINT as never;
      it.current = seq === 0 ? 1 : 0;
      it.autocontinue = 1;
      it.param1 = 0; // hold time
      it.param2 = this.cfg.kind === 'uav' ? 2 : 1; // acceptance radius (m)
      it.param3 = 0;
      it.param4 = NaN; // keep current yaw
      it.x = Math.round(g.lat * 1e7);
      it.y = Math.round(g.lon * 1e7);
      it.z = alt;
      it.missionType = 0 as never;
      return it;
    });
  }

  private uploadMission(route: Point[]): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const items = this.buildMission(route);
      const timer = setTimeout(() => {
        this.missionWaiter = null;
        resolve({ ok: false, detail: 'Mission upload timed out.' });
      }, 2000 + items.length * 700);
      this.missionWaiter = { items, done: { timer, resolve: (ok, detail) => resolve({ ok, detail }) } };
      const count = new common.MissionCount();
      count.targetSystem = this.sys;
      count.targetComponent = this.comp;
      count.count = items.length;
      count.missionType = 0 as never;
      this.send(count);
    });
  }

  private setMode(mode: number) {
    this.expectMode = mode;
    const px = this.cfg.profile.startsWith('px4');
    return px
      ? this.command(CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, (mode >> 16) & 0xff, (mode >> 24) & 0xff])
      : this.command(CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode]);
  }

  onCommand(cmd: SrvCommand) {
    if (!admitCommand(this.ctx, this.declaration, this.ledger, cmd)) return;
    const fail = (detail: string, status: 'rejected' | 'failed' = 'failed') => {
      this.ledger.record(cmd, status, detail);
      this.ctx.commandUpdate({ commandId: cmd.commandId, status, detail });
    };
    const now = this.ctx.now();
    if (!this.lastHeartbeat || now - this.lastHeartbeat > LINK_STALE_MS) return fail('No heartbeat from the flight controller. Not sent.', 'rejected');
    const M = MODES[this.cfg.profile];
    void (async () => {
      switch (cmd.type) {
        case 'start': {
          if (!cmd.route?.length) return fail('No route in the start command.', 'rejected');
          if (!this.armed && !this.cfg.allowRemoteArm) return fail('Vehicle is disarmed. Arm it on the remote after the safety check, then send start again.', 'rejected');
          const up = await this.uploadMission(cmd.route);
          if (!up.ok) return fail(up.detail ?? 'Mission upload failed.');
          this.missionLength = cmd.route.length;
          this.nextCp = 0;
          this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'acknowledged', detail: `Route uploaded (${cmd.route.length} waypoints).` });
          if (!this.armed) {
            const a = await this.command(CMD.COMPONENT_ARM_DISARM, [1]);
            if (!a.ok) return fail(`Arming refused: ${a.detail}`);
          }
          const m = await this.setMode(M.auto[0]);
          if (!m.ok) return fail(`AUTO mode refused: ${m.detail}`);
          const s = await this.command(CMD.MISSION_START, [0, 0]);
          if (!s.ok && !M.auto.includes(this.mode)) return fail(`Mission start refused: ${s.detail}`);
          this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing' });
          this.activeStart = { cmd, commandId: cmd.commandId, since: this.ctx.now() };
          return;
        }
        case 'pause': {
          const r = await this.command(CMD.DO_PAUSE_CONTINUE, [0]);
          const ok = r.ok || (await this.setMode(M.hold[0])).ok;
          if (!ok) return fail('Pause refused by the vehicle.');
          this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing', detail: 'Waiting for the vehicle to stop.' });
          this.activeStop = { commandId: cmd.commandId, type: 'pause' };
          return;
        }
        case 'resume': {
          const r = await this.command(CMD.DO_PAUSE_CONTINUE, [1]);
          const ok = r.ok || (await this.setMode(M.auto[0])).ok;
          if (!ok) return fail('Resume refused by the vehicle.');
          this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing' });
          this.activeResume = { commandId: cmd.commandId, since: this.ctx.now() };
          return;
        }
        case 'stop': {
          const r = await this.setMode(M.hold[0]);
          if (!r.ok) return fail(`Hold mode refused: ${r.detail}`);
          this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing', detail: 'Hold requested. Waiting for speed 0.' });
          this.activeStop = { commandId: cmd.commandId, type: 'stop' };
          return;
        }
      }
    })();
  }
}
