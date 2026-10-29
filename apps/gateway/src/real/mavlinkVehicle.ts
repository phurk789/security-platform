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
//  • Live driving (`teleop`, UGVs) overrides only the steering and throttle sticks, only while the
//    pilot has armed the vehicle in a manual mode, and stops when stick samples stop coming. The
//    arm switch and the mode switch stay on the remote.
import dgram from 'node:dgram';
import { ComponentTracker } from '../adapters/components';
import { PassThrough } from 'node:stream';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, ardupilotmega, common, minimal, type MavLinkPacket } from 'node-mavlink';
import {
  PAYLOAD_CATALOG,
  VEHICLE_CATALOG,
  catalogCapabilities,
  geoToSite,
  headingToSite,
  siteToGeo,
  type AdapterDeclaration,
  type CameraAction,
  type GeoAnchor,
  type Point,
  type SrvCommand,
  type SrvDrive,
  type StreamInfo,
  type TeleopLimits,
} from '@13store/shared';
import { CommandLedger, admitCommand, type Adapter, type AdapterContext } from '../sdk';
import type { PushState } from '../videoPush';
import { DriveState } from '../drive';
import { forceMainStreamH264 } from './siyiCodec';
import { GCS_RELAY_DEFAULT, GcsRelay } from './gcsRelay';

/** Try the camera codec fix at most this often (the camera restart takes several seconds). */
export const CODEC_FIX_INTERVAL_MS = 10 * 60_000;

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
  /**
   * ArduPilot: turn the geofence on (MAV_CMD_DO_FENCE_ENABLE) before a route starts, and off again
   * once the vehicle is disarmed. Keep FENCE_ENABLE = 0 on the board: a fence that is on at arming
   * needs a GPS position, so with it stored on the vehicle cannot be armed indoors. The fence
   * itself (FENCE_TYPE / RADIUS / ACTION) is set on the board. Default false.
   */
  missionFence?: boolean;
  firmwareTested?: string;
  flightController?: string;
  radio?: string;
  gcsSystemId?: number;
  /** Catalogue model (e.g. D50, D100, D200): sets capabilities and rated specs. */
  catalogId?: string;
  /**
   * 4-in-1 module wired to the flight controller's relay outputs (ArduPilot RELAYn_PIN / PX4
   * actuator). The platform switches it with MAV_CMD_DO_SET_RELAY. Announcements are not sent over
   * MAVLink; they use the module's own audio link.
   */
  payload?: { module: 'loudhailer-4in1'; spotlightRelay?: number; beaconRelay?: number };
  /**
   * Indoor vehicle without GPS: ArduPilot's EKF fed by external navigation (SLAM via
   * VISION_POSITION_ESTIMATE). Position is read from LOCAL_POSITION_NED relative to `origin`
   * (site metres), turned by `yawDeg` (degrees clockwise from site east).
   */
  indoor?: { buildingId: string; level: number; origin: { x: number; y: number }; yawDeg?: number };
  /**
   * Onboard camera video served by the site media server (MediaMTX pulls the camera's RTSP).
   * Declared on the vehicle so the console shows it on the unit card and in the command centre.
   * Video only: the adapter does not talk to the camera, so its part stays "pending" until a
   * person checks the picture.
   */
  stream?: StreamInfo;
  /**
   * Live driving from the console (UGVs only): stick samples become RC_CHANNELS_OVERRIDE on the
   * steering and throttle channels. `true` takes the defaults (TELEOP_DEFAULTS).
   */
  teleop?: true | TeleopConfig;
  /**
   * When the pushed camera video turns out to be H.265, switch the camera's main stream back to
   * H.264 over the SIYI SDK (UDP 37260 on the stream's host) and restart it. Default true.
   */
  fixCameraCodec?: boolean;
  /** Replaces the SIYI codec fix (tests). */
  codecFixer?: typeof forceMainStreamH264;
  /**
   * Relay for a ground station on the same machine (UniGCS on the SIYI remote, E-5): the gateway stays the only client
   * of the datalink and forwards everything between it and the ground station, which connects to host:port (default
   * 127.0.0.1:19857) instead of the datalink. While the console drives, the ground station's stick input is held back;
   * everything else (a mode change to HOLD, a disarm) goes through. The gateway then uses component id 191, so replies
   * meant for the ground station (190) are not taken for its own. `true` takes the defaults.
   */
  gcsRelay?: boolean | { host?: string; port?: number };
  /** How long a silent ground station counts as connected (tests). */
  gcsRelayStaleMs?: number;
}

/** Live driving from the console. Every field is optional; see TELEOP_DEFAULTS. */
export interface TeleopConfig {
  /** Largest throttle the console may ask for, as a fraction of full stick (0–1). */
  maxThrottle?: number;
  /** Largest steering, as a fraction of full stick (0–1). */
  maxSteer?: number;
  /** The vehicle stops when no stick sample arrived for this long (ms, 100–3000). */
  deadmanMs?: number;
  /** RC input channels for steering and throttle (ArduPilot RCMAP_ROLL / RCMAP_THROTTLE). */
  steerChannel?: number;
  throttleChannel?: number;
  /** Stick centre and full travel either side of it (µs). */
  center?: number;
  travel?: number;
  /** Flip a direction when right/forward on the console comes out left/backward on the vehicle. */
  reverseSteer?: boolean;
  reverseThrottle?: boolean;
}

export const TELEOP_DEFAULTS: Required<TeleopConfig> = {
  maxThrottle: 0.3,
  maxSteer: 0.6,
  deadmanMs: 500,
  steerChannel: 1,
  throttleChannel: 3,
  center: 1500,
  travel: 400,
  reverseSteer: false,
  reverseThrottle: false,
};

/** What is wrong with a teleop setting, or undefined when it is fine. */
export function teleopProblem(t: unknown): string | undefined {
  if (t === undefined || t === true) return undefined;
  if (!t || typeof t !== 'object') return 'teleop must be true or an object';
  const c = { ...TELEOP_DEFAULTS, ...(t as TeleopConfig) };
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!num(c.maxThrottle, 0.01, 1) || !num(c.maxSteer, 0.01, 1)) return 'teleop.maxThrottle and maxSteer must be between 0.01 and 1';
  if (!num(c.deadmanMs, 100, 3000)) return 'teleop.deadmanMs must be between 100 and 3000';
  if (!Number.isInteger(c.steerChannel) || !Number.isInteger(c.throttleChannel) || !num(c.steerChannel, 1, 18) || !num(c.throttleChannel, 1, 18))
    return 'teleop.steerChannel and throttleChannel must be RC channels 1–18';
  if (c.steerChannel === c.throttleChannel) return 'teleop.steerChannel and throttleChannel must differ';
  if (!num(c.center, 1000, 2000) || !num(c.travel, 50, 500) || c.center - c.travel < 800 || c.center + c.travel > 2200)
    return 'teleop.center ± travel must stay within 800–2200 µs';
  return undefined;
}

/** RC overrides go out this often while driving (ArduPilot drops them after RC_OVERRIDE_TIME). */
const DRIVE_TICK_MS = 100;
/** RC_CHANNELS_OVERRIDE values: channels 1–8 ignore 65535 and release on 0; 9–18 ignore 0 and release on 65534. */
const rcIgnore = (ch: number) => (ch <= 8 ? 65535 : 0);
const rcRelease = (ch: number) => (ch <= 8 ? 0 : 65534);

/** UniRC 7 / 7 Pro datalink UDP server (SIYI manual: QGroundControl "server address"). */
export const UNIRC7_DATALINK = { host: '192.168.144.20', port: 19856 };

const REGISTRY = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY };

// MAVLink ids (common.xml)
const MSG = {
  HEARTBEAT: 0,
  SYS_STATUS: 1,
  GPS_RAW_INT: 24,
  LOCAL_POSITION_NED: 32,
  GLOBAL_POSITION_INT: 33,
  MISSION_REQUEST: 40,
  MISSION_CURRENT: 42,
  MISSION_ITEM_REACHED: 46,
  MISSION_ACK: 47,
  MISSION_REQUEST_INT: 51,
  VFR_HUD: 74,
  COMMAND_ACK: 77,
  RC_CHANNELS_OVERRIDE: 70,
  RADIO_STATUS: 109,
  STATUSTEXT: 253,
};
/** Answers the vehicle addresses to one ground station (target_component). */
const REPLIES = new Set([MSG.COMMAND_ACK, MSG.MISSION_REQUEST, MSG.MISSION_REQUEST_INT, MSG.MISSION_ACK]);
const CMD = {
  NAV_WAYPOINT: 16,
  DO_SET_RELAY: 181,
  DO_SET_MODE: 176,
  DO_PAUSE_CONTINUE: 193,
  DO_FENCE_ENABLE: 207,
  MISSION_START: 300,
  COMPONENT_ARM_DISARM: 400,
  SET_MESSAGE_INTERVAL: 511,
};
const FRAME_GLOBAL_RELATIVE_ALT_INT = 6;
const MAV_MODE_FLAG_SAFETY_ARMED = 128;
const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1;
const LINK_STALE_MS = 3000;
/** A position older than this (no fresh fix) is not reported: the sample goes out without one. */
const POS_STALE_MS = 3000;

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
  /** Replaced by the gateway's (persistent) ledger in start(). */
  private ledger = new CommandLedger();
  private input = new PassThrough();
  private ackWaiters = new Map<number, Pending>();
  private missionWaiter: { items: ReturnType<MavlinkVehicleAdapter['buildMission']>; done: Pending } | null = null;

  // vehicle state
  private sys = 0;
  private comp = 0;
  private lastHeartbeat = 0;
  private payloadState = { spotlight: false, beacon: false };
  private comps: ComponentTracker;
  private payloadQueue: Promise<unknown> = Promise.resolve();
  private armed = false;
  private mode = -1;
  private pos?: Point;
  /** When `pos` was last set from a trusted source (GNSS 3D fix, or indoor positioning). */
  private posAt = 0;
  /** GPS_RAW_INT fix type (0–1 none, 2 2D, 3 3D, 4 DGPS, 5–6 RTK); undefined until the first one. */
  private fixType?: number;
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
  /** The platform turned the geofence on for a route (missionFence) and has not turned it off yet. */
  private fenceOn = false;
  private fenceOffBusy = false;
  private wasStale = false;
  private lastTel = 0;

  // live driving
  private teleop?: Required<TeleopConfig>;
  private drive = new DriveState(TELEOP_DEFAULTS.deadmanMs);
  /** True while RC overrides are going out (the pilot's sticks are not in charge). */
  private overriding = false;
  /** Overrides have gone out to an armed vehicle at least once (the part is then known to work). */
  private droveOnce = false;
  // camera codec fix
  private codecFixAt = 0;
  private codecFixNote?: string;
  // local ground station relay (UniGCS)
  private relayCfg?: { host: string; port: number };
  private relay?: GcsRelay;
  /** Our component id: 190 like any GCS, 191 when a relayed ground station uses 190. */
  private readonly myComp: number;

  constructor(private cfg: MavlinkVehicleConfig) {
    this.relayCfg = cfg.gcsRelay ? { ...GCS_RELAY_DEFAULT, ...(cfg.gcsRelay === true ? {} : cfg.gcsRelay) } : undefined;
    this.myComp = this.relayCfg ? 191 : 190;
    this.proto = new MavLinkProtocolV2(cfg.gcsSystemId ?? 255, this.myComp);
    const uav = cfg.kind === 'uav';
    if (cfg.teleop && !uav) {
      const problem = teleopProblem(cfg.teleop);
      if (problem) throw new Error(`${cfg.deviceId}: ${problem}`);
      this.teleop = { ...TELEOP_DEFAULTS, ...(cfg.teleop === true ? {} : cfg.teleop) };
      this.drive = new DriveState(this.teleop.deadmanMs);
    }
    this.comps = new ComponentTracker([
      { id: 'fc', name: cfg.flightController ?? 'Flight controller (MAVLink)', kind: 'flight_controller', status: 'pending', detail: 'Waiting for the first heartbeat' },
      ...(cfg.indoor ? [] : [{ id: 'gnss', name: 'GNSS receiver', kind: 'gnss' as const, status: 'pending' as const, detail: 'Waiting for GPS_RAW_INT' }]),
      { id: 'radio', name: cfg.radio ?? 'Telemetry radio', kind: 'radio', status: 'pending', detail: 'Waiting for RADIO_STATUS' },
      { id: 'battery', name: 'Battery', kind: 'battery', status: 'pending', detail: 'Waiting for SYS_STATUS' },
      ...(cfg.payload && PAYLOAD_CATALOG[cfg.payload.module]
        ? [{ id: 'payload', name: PAYLOAD_CATALOG[cfg.payload.module].name, kind: 'payload' as const, status: 'pending' as const, detail: 'Relay outputs not yet exercised' }]
        : []),
      ...(cfg.stream
        ? [
            {
              id: 'cam',
              name: 'Onboard camera (video only)',
              kind: 'camera' as const,
              status: 'pending' as const,
              detail: cfg.stream.push
                ? `Waiting to push ${cfg.stream.rtsp ?? 'the camera'} to the platform media server`
                : `Video through the site media server from ${cfg.stream.rtsp ?? 'the camera'}; check the picture in the console`,
              stream: cfg.stream,
            },
          ]
        : []),
      ...(this.teleop
        ? [
            {
              id: 'drive',
              name: 'Console driving (RC override)',
              kind: 'other' as const,
              status: 'pending' as const,
              detail: `Not driven from the console yet · steering ch${this.teleop.steerChannel}, throttle ch${this.teleop.throttleChannel}`,
            },
          ]
        : []),
      ...(this.relayCfg
        ? [
            {
              id: 'gcs',
              name: 'Ground station on the remote (UniGCS, relayed)',
              kind: 'remote' as const,
              status: 'pending' as const,
              detail: `Not connected · UniGCS: UDPCL ${this.relayCfg.host} port ${this.relayCfg.port}`,
            },
          ]
        : []),
    ]);
    this.declaration = {
      deviceId: cfg.deviceId,
      kind: cfg.kind,
      model: cfg.model ?? (uav ? 'MAVLink multicopter' : 'MAVLink rover'),
      adapterVersion: 'mavlink-vehicle 1.0',
      protocolVersion: `MAVLink 2 · ${cfg.profile}`,
      firmwareTested: cfg.firmwareTested ?? 'not yet tested on hardware',
      integration: 'testing',
      capabilities: [
        ...(cfg.catalogId && VEHICLE_CATALOG[cfg.catalogId]
          ? catalogCapabilities(cfg.catalogId)
          : uav
            ? ['camera', 'overwatch', 'waypoints']
            : ['camera', 'ground_patrol', 'waypoints']),
        ...(cfg.payload?.spotlightRelay !== undefined ? ['spotlight'] : []),
        ...(cfg.payload?.beaconRelay !== undefined ? ['beacon'] : []),
        ...(cfg.stream ? ['video'] : []),
      ],
      stream: cfg.stream,
      catalogId: cfg.catalogId && VEHICLE_CATALOG[cfg.catalogId] ? cfg.catalogId : undefined,
      indoor: cfg.indoor ? { buildingId: cfg.indoor.buildingId, level: cfg.indoor.level, positioning: 'slam' } : undefined,
      payloads: cfg.payload && PAYLOAD_CATALOG[cfg.payload.module] ? [cfg.payload.module] : undefined,
      teleop: this.teleop ? ({ maxThrottle: this.teleop.maxThrottle, maxSteer: this.teleop.maxSteer, deadmanMs: this.teleop.deadmanMs } satisfies TeleopLimits) : undefined,
      commands: ['start', 'pause', 'resume', 'stop'],
      components: this.comps.list(),
      units: { position: 'site-m', altitude: 'm-site-datum', speed: 'm/s', battery: 'percent' },
      rateMs: 1000,
      limitations: `Flight controller via ${cfg.link.mode === 'client' ? `${cfg.link.host}:${cfg.link.port}` : `UDP :${cfg.link.port}`}. ${cfg.allowRemoteArm ? 'Remote arming enabled.' : 'Arm on the remote; the platform will not arm.'}${this.teleop ? ` Console driving overrides steering and throttle only, while armed in a manual mode; it stops ${this.teleop.deadmanMs} ms after stick samples stop.` : ''}${this.relayCfg ? ` UniGCS on the remote may run at the same time through the gateway (${this.relayCfg.host}:${this.relayCfg.port}); its commands do not pass the platform's approvals.` : ''}`,
      linkLossBehavior: uav
        ? 'Flight controller GCS failsafe (e.g. FS_GCS_ENABLE / NAV_DLL_ACT): RTL or loiter as configured on the vehicle.'
        : 'Flight controller GCS failsafe (e.g. FS_GCS_ENABLE, FS_ACTION=Hold): stop in place as configured on the vehicle.',
    };
  }

  // ---- lifecycle ---------------------------------------------------------------

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.ledger = ctx.ledger;
    const stream = this.input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
    stream.on('data', (p: MavLinkPacket) => this.onPacket(p));
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (msg, rinfo) => {
      if (this.cfg.link.mode === 'listen') this.peer = { host: rinfo.address, port: rinfo.port };
      this.input.write(msg);
      this.relay?.fromVehicle(msg);
    });
    sock.on('error', (e) => ctx.log.warn(`${this.cfg.deviceId}: UDP error ${e.message}`));
    if (this.cfg.link.mode === 'client') {
      this.peer = { host: this.cfg.link.host, port: this.cfg.link.port };
      sock.bind(0);
    } else sock.bind(this.cfg.link.port);
    if (this.relayCfg) {
      this.relay = new GcsRelay({
        deviceId: this.cfg.deviceId,
        ...this.relayCfg,
        log: ctx.log,
        now: () => ctx.now(),
        toVehicle: (b) => this.peer && this.sock?.send(b, this.peer.port, this.peer.host),
        driving: () => this.drive.active || this.overriding,
        modeName: (m) => MODES[this.cfg.profile].name(m),
        staleMs: this.cfg.gcsRelayStaleMs,
        onChange: (s, note) =>
          this.comps.set('gcs', {
            status: s.connected ? 'ok' : 'offline',
            detail: s.connected
              ? `Connected through the gateway${s.sysid !== undefined ? ` (sys ${s.sysid})` : ''}${note ? ` · last: ${note.replace(/^UniGCS on the remote: /, '')}` : ''}`
              : `Disconnected · UniGCS: UDPCL ${s.listen.replace(':', ' port ')}`,
          }),
      });
      this.relay.start();
    }
    this.timers.push(
      setInterval(() => this.sendGcsHeartbeat(), 1000),
      setInterval(() => this.tick(), 250),
    );
    if (this.teleop) this.timers.push(setInterval(() => this.driveTick(), DRIVE_TICK_MS));
    this.sendGcsHeartbeat();
  }

  stop() {
    if (this.drive.active || this.overriding) this.endDrive('gateway stopping');
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.relay?.stop();
    this.relay = undefined;
    this.sock?.close();
    this.sock = undefined;
  }

  /** The local ground station relay (UniGCS on the remote), for the gateway's status. */
  relayState() {
    return this.relay?.state;
  }

  onDemo() {
    /* real vehicle: presenter controls never touch it */
  }

  /** Pushed video: shown on the camera part (rides along with the next telemetry sample). */
  onMediaState(s: PushState) {
    const hevc = s.codec === 'hevc';
    if (s.status === 'pushing' && hevc) this.fixCameraCodec();
    this.comps.set('cam', {
      status: s.status === 'pushing' ? (hevc ? 'warn' : 'ok') : s.status === 'missing' ? 'fault' : s.status === 'stopped' ? 'offline' : 'warn',
      detail:
        s.status === 'pushing' && hevc
          ? this.codecFixNote
            ? `The camera sent H.265, which browsers cannot play. ${this.codecFixNote}`
            : 'Pushing H.265, which browsers cannot play: switching the camera main stream to H.264'
          : s.detail,
    });
  }

  /**
   * The camera sends H.265 (SIYI cameras fall back to it by themselves): switch its main stream
   * back to H.264 and restart it. At most once per CODEC_FIX_INTERVAL_MS, so it can never loop.
   */
  private fixCameraCodec() {
    if (this.cfg.fixCameraCodec === false || !this.cfg.stream?.rtsp || !this.ctx) return;
    const now = this.ctx.now();
    if (this.codecFixAt && now - this.codecFixAt < CODEC_FIX_INTERVAL_MS) return;
    this.codecFixAt = now;
    let host: string;
    try {
      host = new URL(this.cfg.stream.rtsp).hostname;
    } catch {
      return;
    }
    const fix = this.cfg.codecFixer ?? forceMainStreamH264;
    void fix({ host }).then((r) => {
      this.codecFixNote = r.detail;
      this.ctx.log[r.changed ? 'info' : 'warn'](`${this.cfg.deviceId}: camera sent H.265. ${r.detail}`);
      this.comps.set('cam', { status: 'warn', detail: `The camera sent H.265, which browsers cannot play. ${r.detail}` });
    });
  }

  // ---- live driving ------------------------------------------------------------------
  //
  // The server forwards the driver's stick samples (about ten a second). Each one is capped and
  // sent as RC_CHANNELS_OVERRIDE on the steering and throttle channels only, so the arm switch and
  // the mode switch stay with the pilot. When samples stop for `deadmanMs` the sticks go to neutral;
  // DRIVE_NEUTRAL_HOLD_MS later they are handed back to the remote.

  onDrive(s: SrvDrive) {
    if (!this.teleop || !this.ctx) return;
    const r = this.drive.accept(s, this.ctx.now());
    if (r === 'release') return this.endDrive('released by the console');
    if (r === 'late') return;
    if (r === 'start') {
      this.ctx.log.info(`${this.cfg.deviceId}: console driving started`);
      this.setPositionRate(250_000);
    }
    this.driveTick();
  }

  /** Why the vehicle may not be driven right now, or undefined when it may. */
  private driveBlocked(now: number): string | undefined {
    if (!this.lastHeartbeat || now - this.lastHeartbeat > LINK_STALE_MS) return 'No heartbeat from the flight controller';
    const M = MODES[this.cfg.profile];
    if (!M.manual.includes(this.mode)) return `The vehicle is in ${M.name(this.mode)}: switch it to MANUAL on the remote`;
    if (!this.armed) return 'The vehicle is disarmed: the pilot arms it on the remote';
    return undefined;
  }

  private driveTick() {
    const t = this.teleop;
    if (!t || !this.drive.active) return;
    const now = this.ctx.now();
    const step = this.drive.step(now)!;
    if (step.kind === 'end') return this.endDrive(step.reason);
    const blocked = this.driveBlocked(now);
    if (blocked) {
      // Never fight the vehicle or the pilot: give the sticks back and say why.
      if (this.overriding) this.releaseSticks();
      this.drive.interrupt();
      this.comps.set('drive', { status: 'warn', detail: `Not driving. ${blocked}.` });
      return;
    }
    if (step.kind === 'drive') this.sendSticks(step.throttle, step.steer);
    else this.sendSticks(0, 0);
    this.droveOnce = true;
    this.comps.set(
      'drive',
      step.kind === 'drive'
        ? { status: 'ok', detail: `Driving from the console · throttle ≤${Math.round(t.maxThrottle * 100)}% · steering ≤${Math.round(t.maxSteer * 100)}%` }
        : step.reason === 'deadman'
          ? { status: 'warn', detail: 'No stick input from the console: stopped' }
          : { status: 'warn', detail: 'Stopped: centre the sticks to drive' },
    );
  }

  private endDrive(why: string) {
    const was = this.drive.active;
    this.drive.end();
    if (this.overriding) {
      this.sendSticks(0, 0); // stop first, then hand the sticks back
      this.releaseSticks();
    }
    if (was) {
      this.ctx.log.info(`${this.cfg.deviceId}: console driving ended (${why})`);
      this.setPositionRate(1_000_000);
    }
    this.comps.set('drive', { status: this.droveOnce ? 'ok' : 'pending', detail: `Idle, the remote has the sticks (${why})` });
  }

  /** Throttle and steering in −1…1 of the capped range → RC override on those two channels. */
  private sendSticks(throttle: number, steer: number) {
    const t = this.teleop!;
    const pwm = (v: number, cap: number, reverse: boolean) => Math.round(t.center + (reverse ? -v : v) * cap * t.travel);
    this.sendOverride({ [t.steerChannel]: pwm(steer, t.maxSteer, t.reverseSteer), [t.throttleChannel]: pwm(throttle, t.maxThrottle, t.reverseThrottle) });
    this.overriding = true;
  }

  /** Hand the two channels back to the remote. Sent twice (UDP); ArduPilot also drops overrides after RC_OVERRIDE_TIME. */
  private releaseSticks() {
    const t = this.teleop!;
    const msg = { [t.steerChannel]: rcRelease(t.steerChannel), [t.throttleChannel]: rcRelease(t.throttleChannel) };
    this.sendOverride(msg);
    this.sendOverride(msg);
    this.overriding = false;
  }

  /** RC_CHANNELS_OVERRIDE with the given channels set and every other channel left alone. */
  private sendOverride(values: Record<number, number>) {
    const o = new common.RcChannelsOverride();
    o.targetSystem = this.sys;
    o.targetComponent = this.comp;
    const raw = o as unknown as Record<string, number>;
    for (let ch = 1; ch <= 18; ch++) raw[`chan${ch}Raw`] = values[ch] ?? rcIgnore(ch);
    this.send(o);
  }

  /** Position and speed come faster while someone drives (the map and speed readout keep up). */
  private setPositionRate(intervalUs: number) {
    if (!this.sys) return;
    for (const id of [MSG.GLOBAL_POSITION_INT, MSG.VFR_HUD]) this.commandLong(CMD.SET_MESSAGE_INTERVAL, [id, intervalUs]);
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
        this.ctx.log.info(
          `${this.cfg.deviceId}: vehicle found (sys ${this.sys}, ${(hb.autopilot as number) === 12 ? 'PX4' : (hb.autopilot as number) === 3 ? 'ArduPilot' : `autopilot ${hb.autopilot}`})`,
        );
        this.requestStreams();
      }
      if (p.header.sysid !== this.sys) return;
      const now = this.ctx.now();
      this.comps.set('fc', {
        status: 'ok',
        version: (hb.autopilot as number) === 12 ? 'PX4' : (hb.autopilot as number) === 3 ? 'ArduPilot' : `autopilot ${hb.autopilot}`,
        detail: `sys ${this.sys} · ${MODES[this.cfg.profile].name(hb.customMode)}`,
      });
      if (this.wasStale && this.lastHeartbeat) this.onReconnect(hb.customMode);
      this.wasStale = false;
      this.lastHeartbeat = now;
      this.armed = ((hb.baseMode as number) & MAV_MODE_FLAG_SAFETY_ARMED) !== 0;
      if (!this.armed && this.fenceOn) this.fenceOff(); // retried every heartbeat until confirmed
      this.onMode(hb.customMode);
      return;
    }
    if (!this.sys || p.header.sysid !== this.sys) return;
    const data = p.protocol.data(p.payload, clazz) as unknown as Record<string, number | string>;
    // With a relayed ground station on the same link, answers addressed to it (its component id) are not ours.
    if (this.relayCfg && REPLIES.has(p.header.msgid) && Number(data.targetComponent) && Number(data.targetComponent) !== this.myComp) return;
    switch (p.header.msgid) {
      case MSG.LOCAL_POSITION_NED: {
        if (!this.cfg.indoor) break;
        // NED: x north, y east. Site: x east, y south; then turn by yawDeg about the origin.
        const th = ((this.cfg.indoor.yawDeg ?? 0) * Math.PI) / 180;
        const ex = data.y as number;
        const ey = -(data.x as number);
        this.pos = { x: this.cfg.indoor.origin.x + ex * Math.cos(th) - ey * Math.sin(th), y: this.cfg.indoor.origin.y + ex * Math.sin(th) + ey * Math.cos(th) };
        this.posAt = this.ctx.now();
        this.speed = Math.hypot(data.vx as number, data.vy as number);
        this.accuracyM = 0.3;
        break;
      }
      case MSG.GLOBAL_POSITION_INT: {
        if (this.cfg.indoor) break; // GPS is not trusted indoors
        const lat = (data.lat as number) / 1e7;
        const lon = (data.lon as number) / 1e7;
        // Before the GNSS has a 3D fix the autopilot sends 0,0 or a drifting estimate: not a position.
        if (lat === 0 && lon === 0) break;
        if (this.fixType !== undefined && this.fixType < 3) break;
        this.pos = geoToSite(this.cfg.geo, { lat, lon });
        this.posAt = this.ctx.now();
        this.altM = (data.relativeAlt as number) / 1000;
        if ((data.hdg as number) !== 65535) this.headingDeg = headingToSite(this.cfg.geo, (data.hdg as number) / 100);
        this.speed = Math.hypot(data.vx as number, data.vy as number) / 100;
        break;
      }
      case MSG.VFR_HUD:
        this.speed = data.groundspeed as number;
        break;
      case MSG.SYS_STATUS:
        if ((data.batteryRemaining as number) >= 0) {
          this.battery = data.batteryRemaining as number;
          this.comps.set('battery', {
            status: this.battery < 15 ? 'fault' : this.battery < 30 ? 'warn' : 'ok',
            detail: `${this.battery}%${(data.voltageBattery as number) > 0 && (data.voltageBattery as number) !== 65535 ? ` · ${((data.voltageBattery as number) / 1000).toFixed(1)} V` : ''}`,
          });
        }
        break;
      case MSG.GPS_RAW_INT: {
        this.satellites = data.satellitesVisible as number;
        const hAcc = (data.hAcc as number) ?? 0;
        const eph = data.eph as number;
        this.accuracyM = hAcc > 0 ? hAcc / 1000 : eph && eph !== 65535 ? (eph / 100) * 2.5 : 5;
        const fix = data.fixType as number;
        this.fixType = fix;
        this.comps.set('gnss', {
          status: fix >= 3 ? 'ok' : 'warn',
          detail: fix >= 3 ? `${this.satellites} sats · ${fix >= 5 ? 'RTK' : '3D'} fix · ±${this.accuracyM.toFixed(1)} m` : `${this.satellites} sats · no 3D fix`,
        });
        break;
      }
      case MSG.RADIO_STATUS:
        if ((data.rssi as number) !== 255) {
          this.signal = Math.round(((data.rssi as number) / 254) * 100);
          this.comps.set('radio', { status: this.signal < 25 ? 'warn' : 'ok', detail: `RSSI ${this.signal}%` });
        }
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
    this.relay?.tick();
    const fresh = this.lastHeartbeat && now - this.lastHeartbeat < LINK_STALE_MS;
    if (!fresh) {
      this.wasStale = true;
      this.comps.set('fc', { status: 'offline', detail: 'No heartbeat' });
      return; // no telemetry → the platform shows STALE, then OFFLINE
    }
    if (now - this.lastTel >= (this.drive.active ? 250 : 1000)) {
      this.lastTel = now;
      // The vehicle is alive (heartbeat), so it always reports; the position only while it is trusted.
      const havePos = !!this.pos && now - this.posAt <= POS_STALE_MS;
      this.ctx.telemetry({
        seq: ++this.telSeq,
        sourceTime: this.lastHeartbeat,
        ...(havePos ? { pos: { ...this.pos! } } : {}),
        alt: this.cfg.kind === 'uav' ? this.altM : undefined,
        accuracyM: Math.round(this.accuracyM * 10) / 10,
        battery: this.battery,
        speed: Math.round(this.speed * 10) / 10,
        quality: havePos && this.accuracyM < 3 ? 'good' : 'degraded',
        nextCp: this.missionLength ? this.nextCp : undefined,
        heading: this.headingDeg,
        signal: this.signal,
        satellites: this.cfg.indoor ? undefined : this.satellites,
        level: this.cfg.indoor?.level,
        // 4-in-1 module state as last confirmed by the flight controller (no gimbal on this device)
        gimbal: this.cfg.payload ? { yaw: 0, pitch: 0, spotlight: this.payloadState.spotlight, beacon: this.payloadState.beacon } : undefined,
        components: this.comps.flush(),
      } as Parameters<AdapterContext['telemetry']>[0]);
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
      const timer = setTimeout(
        () => {
          this.missionWaiter = null;
          resolve({ ok: false, detail: 'Mission upload timed out.' });
        },
        2000 + items.length * 700,
      );
      this.missionWaiter = { items, done: { timer, resolve: (ok, detail) => resolve({ ok, detail }) } };
      const count = new common.MissionCount();
      count.targetSystem = this.sys;
      count.targetComponent = this.comp;
      count.count = items.length;
      count.missionType = 0 as never;
      this.send(count);
    });
  }

  /** Turn the platform's geofence off again after the vehicle disarmed, so it can be armed indoors. */
  private fenceOff() {
    if (this.fenceOffBusy) return;
    this.fenceOffBusy = true;
    void this.command(CMD.DO_FENCE_ENABLE, [0]).then((r) => {
      this.fenceOffBusy = false;
      if (!r.ok) return this.ctx.log.warn(`${this.cfg.deviceId}: geofence not turned off yet (${r.detail}); retrying`);
      this.fenceOn = false;
      this.ctx.log.info(`${this.cfg.deviceId}: vehicle disarmed, geofence off`);
    });
  }

  private setMode(mode: number) {
    this.expectMode = mode;
    const px = this.cfg.profile.startsWith('px4');
    return px
      ? this.command(CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, (mode >> 16) & 0xff, (mode >> 24) & 0xff])
      : this.command(CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode]);
  }

  /** 4-in-1 module: searchlight and warning light through the flight controller's relays. */
  onCamera(requestId: string, a: CameraAction) {
    const reply = (ok: boolean, confirmed: boolean, detail: string) => this.ctx.cameraResult({ requestId, ok, confirmed, detail });
    if (a.action !== 'spotlight' && a.action !== 'beacon') {
      return reply(
        false,
        false,
        a.action === 'announce' ? 'Announcements use the module’s own audio link, not MAVLink.' : 'This vehicle’s camera is a separate SIYI camera device.',
      );
    }
    const relay = a.action === 'spotlight' ? this.cfg.payload?.spotlightRelay : this.cfg.payload?.beaconRelay;
    if (relay === undefined) return reply(false, false, `No relay configured for the ${a.action === 'spotlight' ? 'searchlight' : 'warning light'}.`);
    const now = this.ctx.now();
    if (!this.lastHeartbeat || now - this.lastHeartbeat > LINK_STALE_MS) return reply(false, false, 'No heartbeat from the flight controller. Not sent.');
    // One relay command at a time: acknowledgements are matched by command id.
    this.payloadQueue = this.payloadQueue.then(async () => {
      const r = await this.command(CMD.DO_SET_RELAY, [relay, a.on ? 1 : 0]);
      if (r.ok) {
        this.payloadState[a.action as 'spotlight' | 'beacon'] = a.on;
        this.comps.set('payload', { status: 'ok', detail: `Relays confirmed by the flight controller` });
      }
      reply(
        r.ok,
        r.ok,
        r.ok
          ? `${a.action === 'spotlight' ? 'Searchlight' : 'Warning light'} ${a.on ? 'on' : 'off'} (relay ${relay}, confirmed by the flight controller).`
          : (r.detail ?? 'Refused.'),
      );
    });
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
          if (this.cfg.missionFence) {
            const f = await this.command(CMD.DO_FENCE_ENABLE, [1]);
            if (!f.ok) return fail(`Geofence could not be turned on (${f.detail}). Route not started.`);
            this.fenceOn = true;
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
