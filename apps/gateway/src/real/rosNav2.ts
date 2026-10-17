// Adapter for a ROS 2 vehicle (Nav2) through rosbridge: indoor UGVs positioned by LiDAR SLAM.
// Pose from AMCL, speed from odometry, battery from the battery topic; missions as a
// NavigateThroughPoses action. Confirmation rules are the platform's: "succeeded" for start only
// once the vehicle moves, for pause/stop only once it has stopped.
//
// rosbridge protocol (rosbridge_suite ≥ 1.3): subscribe / publish / send_action_goal /
// cancel_action_goal / action_feedback / action_result.
import { ComponentTracker } from '../adapters/components';
import WebSocket from 'ws';
import type { AdapterDeclaration, IndoorState, Point, SrvCommand } from '@13store/shared';
import { VEHICLE_CATALOG, catalogCapabilities } from '@13store/shared';
import { CommandLedger, admitCommand, type Adapter, type AdapterContext } from '../sdk';

export interface RosNav2Config {
  deviceId: string;
  kind: 'ugv';
  model?: string;
  /** rosbridge websocket, e.g. ws://192.168.144.60:9090 */
  url: string;
  indoor?: IndoorState;
  /** Where the ROS map frame's origin sits on the site grid (metres) and how it is turned (degrees clockwise from site east). */
  frame: { originX: number; originY: number; yawDeg?: number };
  topics?: { pose?: string; odom?: string; battery?: string };
  /** Nav2 action name. */
  action?: string;
  maxSpeedMps?: number;
  catalogId?: string;
  firmwareTested?: string;
}

const LINK_STALE_MS = 3000;
const STATUS_SUCCEEDED = 4;

type Msg = Record<string, unknown>;

export class RosNav2Adapter implements Adapter {
  readonly declaration: AdapterDeclaration;
  private comps: ComponentTracker;
  private ctx!: AdapterContext;
  private ws?: WebSocket;
  private ledger = new CommandLedger();
  private timers: ReturnType<typeof setInterval>[] = [];
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private telSeq = 0;
  private lastPose = 0;
  private pos: Point = { x: 0, y: 0 };
  private headingDeg = 0;
  private accuracyM = 0.3;
  private speed = 0;
  private battery?: number;
  private goalId?: string;
  private route: Point[] = [];
  private nextCp = 0;
  private active?: { commandId: string; type: 'start' | 'resume' | 'pause' | 'stop'; since: number };

  constructor(private cfg: RosNav2Config) {
    this.comps = new ComponentTracker([
      { id: 'nav', name: 'ROS 2 Nav2 (rosbridge)', kind: 'computer', status: 'pending', detail: 'Connecting' },
      { id: 'slam', name: 'SLAM localisation', kind: 'lidar', status: 'pending', detail: 'Waiting for a pose' },
      { id: 'battery', name: 'Battery', kind: 'battery', status: 'pending', detail: 'Waiting for battery_state' },
    ]);
    this.declaration = {
      deviceId: cfg.deviceId,
      kind: 'ugv',
      model: cfg.model ?? 'ROS 2 Nav2 vehicle',
      adapterVersion: 'ros2-nav2 1.0',
      protocolVersion: 'rosbridge v2 · Nav2 NavigateThroughPoses',
      firmwareTested: cfg.firmwareTested ?? 'not yet tested on hardware',
      integration: 'testing',
      capabilities: [...(cfg.catalogId && VEHICLE_CATALOG[cfg.catalogId] ? catalogCapabilities(cfg.catalogId) : ['camera', 'ground_patrol', 'waypoints']), 'indoor', 'lidar_slam'],
      commands: ['start', 'pause', 'resume', 'stop'],
      units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
      rateMs: 1000,
      limitations: `ROS 2 via ${cfg.url}. Indoor, positioned by SLAM; speed limited to ${cfg.maxSpeedMps ?? 1.5} m/s. No stairs or lifts.`,
      linkLossBehavior: 'Nav2 keeps the current goal; the platform stops reporting and holds new commands. Configure the vehicle to stop on lost heartbeat.',
      catalogId: cfg.catalogId && VEHICLE_CATALOG[cfg.catalogId] ? cfg.catalogId : undefined,
      indoor: cfg.indoor ?? { buildingId: 'unknown', level: 1, positioning: 'slam' },
      components: this.comps.list(),
    } as AdapterDeclaration;
  }

  // ---- frame conversion ---------------------------------------------------------

  private toSite(mx: number, my: number): Point {
    // ROS map: x east, y north (metres). Site grid: x east, y south. yawDeg turns the map clockwise.
    const th = ((this.cfg.frame.yawDeg ?? 0) * Math.PI) / 180;
    const ex = mx * Math.cos(th) + my * Math.sin(th);
    const ey = -mx * Math.sin(th) + my * Math.cos(th);
    return { x: this.cfg.frame.originX + ex, y: this.cfg.frame.originY - ey };
  }

  private toMap(p: Point) {
    const th = ((this.cfg.frame.yawDeg ?? 0) * Math.PI) / 180;
    const ex = p.x - this.cfg.frame.originX;
    const ey = this.cfg.frame.originY - p.y;
    return { x: ex * Math.cos(th) - ey * Math.sin(th), y: ex * Math.sin(th) + ey * Math.cos(th) };
  }

  // ---- lifecycle ------------------------------------------------------------------

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.stopped = false;
    this.connect();
    this.timers.push(setInterval(() => this.tick(), 250));
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.reconnect);
    this.ws?.close();
    this.ws = undefined;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;
    ws.on('open', () => {
      this.ctx.log.info(`${this.cfg.deviceId}: rosbridge connected`);
      const t = this.cfg.topics ?? {};
      this.send({ op: 'subscribe', topic: t.pose ?? '/amcl_pose', type: 'geometry_msgs/msg/PoseWithCovarianceStamped', throttle_rate: 200 });
      this.send({ op: 'subscribe', topic: t.odom ?? '/odom', type: 'nav_msgs/msg/Odometry', throttle_rate: 200 });
      this.send({ op: 'subscribe', topic: t.battery ?? '/battery_state', type: 'sensor_msgs/msg/BatteryState', throttle_rate: 1000 });
    });
    ws.on('message', (raw) => {
      try {
        this.onMessage(JSON.parse(String(raw)) as Msg);
      } catch (e) {
        this.ctx.log.warn(`${this.cfg.deviceId}: bad rosbridge message ${String(e)}`);
      }
    });
    ws.on('error', (e) => this.ctx.log.warn(`${this.cfg.deviceId}: rosbridge ${e.message}`));
    ws.on('close', () => {
      if (this.stopped) return;
      this.reconnect = setTimeout(() => this.connect(), 2000);
    });
  }

  private send(m: Msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ---- incoming ------------------------------------------------------------------

  private onMessage(m: Msg) {
    const t = this.cfg.topics ?? {};
    if (m.op === 'publish') {
      const msg = m.msg as Msg;
      if (m.topic === (t.pose ?? '/amcl_pose')) {
        const pose = ((msg.pose as Msg)?.pose ?? msg.pose) as Msg;
        const p = pose?.position as Msg | undefined;
        const q = pose?.orientation as Msg | undefined;
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          this.pos = this.toSite(p.x, p.y);
          if (q) {
            const yaw = Math.atan2(2 * ((q.w as number) * (q.z as number) + (q.x as number) * (q.y as number)), 1 - 2 * ((q.y as number) ** 2 + (q.z as number) ** 2));
            // ROS yaw: counter-clockwise from +x (east). Site heading: clockwise from north.
            this.headingDeg = (((90 - (yaw * 180) / Math.PI + (this.cfg.frame.yawDeg ?? 0)) % 360) + 360) % 360;
          }
          const cov = (msg.pose as Msg)?.covariance as number[] | undefined;
          if (cov && typeof cov[0] === 'number') this.accuracyM = Math.round(Math.sqrt(Math.max(cov[0], cov[7] ?? 0)) * 100) / 100 || 0.3;
          this.lastPose = this.ctx.now();
          this.comps.set('nav', { status: 'ok', detail: 'Connected' });
          this.comps.set('slam', { status: this.accuracyM <= 1 ? 'ok' : 'warn', detail: `±${this.accuracyM.toFixed(2)} m` });
        }
      } else if (m.topic === (t.odom ?? '/odom')) {
        const lin = ((msg.twist as Msg)?.twist as Msg)?.linear as Msg | undefined;
        if (lin) this.speed = Math.hypot(Number(lin.x) || 0, Number(lin.y) || 0);
      } else if (m.topic === (t.battery ?? '/battery_state')) {
        const pct = Number(msg.percentage);
        if (Number.isFinite(pct)) {
          this.battery = Math.round(pct <= 1 ? pct * 100 : pct);
          this.comps.set('battery', { status: this.battery < 15 ? 'fault' : this.battery < 30 ? 'warn' : 'ok', detail: `${this.battery}%` });
        }
      }
    } else if (m.op === 'action_feedback' && m.id === this.goalId) {
      const fb = m.values as Msg;
      const remaining = Number(fb?.number_of_poses_remaining);
      if (Number.isFinite(remaining)) {
        const cp = Math.max(0, this.route.length - remaining);
        if (cp !== this.nextCp) {
          this.nextCp = cp;
          if (cp > 0 && cp <= this.route.length) this.ctx.event({ kind: 'checkpoint', checkpoint: cp - 1, detail: `Reached checkpoint ${cp}` });
        }
      }
    } else if (m.op === 'action_result' && m.id === this.goalId) {
      const status = Number(m.status);
      this.goalId = undefined;
      if (status === STATUS_SUCCEEDED) {
        this.nextCp = this.route.length;
        this.ctx.event({ kind: 'route_complete', detail: 'Nav2 reached the last pose.' });
      } else if (this.active?.type === 'start' || this.active?.type === 'resume') {
        this.ctx.commandUpdate({ commandId: this.active.commandId, status: 'failed', detail: `Nav2 ended the goal with status ${status}.` });
        this.active = undefined;
      }
    } else if (m.op === 'status' && m.level === 'error') {
      this.ctx.log.warn(`${this.cfg.deviceId}: rosbridge error ${String(m.msg)}`);
    }
  }

  // ---- telemetry and confirmation ------------------------------------------------

  private lastTel = 0;
  private tick() {
    const now = this.ctx.now();
    if (!this.lastPose || now - this.lastPose > LINK_STALE_MS) return; // silence → STALE / OFFLINE
    if (now - this.lastTel >= 1000) {
      this.lastTel = now;
      this.ctx.telemetry({
        seq: ++this.telSeq,
        sourceTime: this.lastPose,
        pos: { x: Math.round(this.pos.x * 100) / 100, y: Math.round(this.pos.y * 100) / 100 },
        accuracyM: this.accuracyM,
        battery: this.battery,
        speed: Math.round(this.speed * 100) / 100,
        quality: this.accuracyM < 0.6 ? 'good' : 'degraded',
        nextCp: this.route.length ? this.nextCp : undefined,
        heading: Math.round(this.headingDeg),
        level: this.cfg.indoor?.level,
        components: this.comps.flush(),
      } as Parameters<AdapterContext['telemetry']>[0]);
    }
    const a = this.active;
    if (!a) return;
    if ((a.type === 'start' || a.type === 'resume') && this.speed > 0.2) {
      this.ctx.commandUpdate({ commandId: a.commandId, status: 'succeeded' });
      this.active = undefined;
    } else if ((a.type === 'pause' || a.type === 'stop') && this.speed < 0.1 && now - a.since > 500) {
      this.ctx.commandUpdate({ commandId: a.commandId, status: 'succeeded' });
      this.active = undefined;
    } else if (now - a.since > 20_000) {
      this.ctx.commandUpdate({ commandId: a.commandId, status: 'failed', detail: 'No effect seen within 20 s.' });
      this.active = undefined;
    }
  }

  // ---- commands ------------------------------------------------------------------

  private sendGoal(poses: Point[]) {
    const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.goalId = id;
    this.send({
      op: 'send_action_goal',
      action: this.cfg.action ?? '/navigate_through_poses',
      action_type: 'nav2_msgs/action/NavigateThroughPoses',
      id,
      feedback: true,
      args: {
        poses: poses.map((p) => {
          const m = this.toMap(p);
          return { header: { frame_id: 'map' }, pose: { position: { x: m.x, y: m.y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } };
        }),
        behavior_tree: '',
      },
    });
  }

  private cancelGoal() {
    if (!this.goalId) return;
    this.send({ op: 'cancel_action_goal', action: this.cfg.action ?? '/navigate_through_poses', id: this.goalId });
    this.goalId = undefined;
  }

  onCommand(cmd: SrvCommand) {
    if (!admitCommand(this.ctx, this.declaration, this.ledger, cmd)) return;
    const fail = (detail: string, status: 'rejected' | 'failed' = 'rejected') => {
      this.ledger.record(cmd, status, detail);
      this.ctx.commandUpdate({ commandId: cmd.commandId, status, detail });
    };
    const now = this.ctx.now();
    if (!this.lastPose || now - this.lastPose > LINK_STALE_MS) return fail('No pose from the vehicle. Not sent.');
    if (this.ws?.readyState !== WebSocket.OPEN) return fail('rosbridge is not connected. Not sent.');
    this.ledger.record(cmd, 'acknowledged');
    this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'acknowledged' });
    switch (cmd.type) {
      case 'start': {
        const route = cmd.route ?? [];
        if (!route.length) return fail('No route in the command.');
        this.route = route.map((p) => ({ ...p }));
        this.nextCp = 0;
        this.cancelGoal();
        this.sendGoal(this.route);
        this.active = { commandId: cmd.commandId, type: 'start', since: now };
        this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing' });
        return;
      }
      case 'resume': {
        const rest = this.route.slice(this.nextCp);
        if (!rest.length) return fail('No route to resume.');
        this.sendGoal(rest);
        this.active = { commandId: cmd.commandId, type: 'resume', since: now };
        this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing' });
        return;
      }
      case 'pause':
      case 'stop': {
        this.cancelGoal();
        if (cmd.type === 'stop') this.route = [];
        this.active = { commandId: cmd.commandId, type: cmd.type, since: now };
        this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'executing' });
        return;
      }
      default:
        return fail(`Command ${cmd.type} is not supported.`);
    }
  }

  onDemo() {
    /* real device */
  }
}
