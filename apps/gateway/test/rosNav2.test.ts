// ROS 2 Nav2 adapter against a fake rosbridge server: pose/odom/battery topics, NavigateThroughPoses
// goal with feedback and result, cancel on pause/stop. Protocol only — no robot here.
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { RosNav2Adapter } from '../src/real/rosNav2';
import { cmd, fakeCtx } from './helpers';

const until = async (f: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
};

/** Minimal rosbridge: a robot at map (2, 3) that drives 1 m/s towards each goal pose. */
function fakeRosbridge() {
  const wss = new WebSocketServer({ port: 0 });
  const st = { pos: { x: 2, y: 3 }, goals: [] as { x: number; y: number }[], goalId: null as string | null, speed: 0, subs: new Set<string>(), cancelled: 0, sent: 0 };
  let client: WebSocket | null = null;
  const send = (m: unknown) => client?.readyState === 1 && client.send(JSON.stringify(m));
  wss.on('connection', (ws) => {
    client = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.op === 'subscribe') st.subs.add(m.topic);
      if (m.op === 'send_action_goal') {
        st.sent++;
        st.goalId = m.id;
        st.goals = m.args.poses.map((p: { pose: { position: { x: number; y: number } } }) => ({ x: p.pose.position.x, y: p.pose.position.y }));
      }
      if (m.op === 'cancel_action_goal' && m.id === st.goalId) {
        st.cancelled++;
        st.goalId = null;
        st.goals = [];
        send({ op: 'action_result', id: m.id, status: 5, result: {} });
      }
    });
  });
  const timer = setInterval(() => {
    // drive
    if (st.goals.length) {
      const g = st.goals[0];
      const dx = g.x - st.pos.x;
      const dy = g.y - st.pos.y;
      const d = Math.hypot(dx, dy);
      const step = 0.1; // 1 m/s at 10 Hz
      st.speed = 1;
      if (d <= step) {
        st.pos = { ...g };
        st.goals.shift();
        send({ op: 'action_feedback', id: st.goalId, values: { number_of_poses_remaining: st.goals.length } });
        if (!st.goals.length) {
          send({ op: 'action_result', id: st.goalId, status: 4, result: {} });
          st.goalId = null;
          st.speed = 0;
        }
      } else st.pos = { x: st.pos.x + (dx / d) * step, y: st.pos.y + (dy / d) * step };
    } else st.speed = 0;
    send({ op: 'publish', topic: '/amcl_pose', msg: { pose: { pose: { position: { x: st.pos.x, y: st.pos.y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, covariance: [0.04, 0, 0, 0, 0, 0, 0, 0.04] } } });
    send({ op: 'publish', topic: '/odom', msg: { twist: { twist: { linear: { x: st.speed, y: 0 } } } } });
    send({ op: 'publish', topic: '/battery_state', msg: { percentage: 0.73 } });
  }, 100);
  return { port: (wss.address() as { port: number }).port, st, close: () => { clearInterval(timer); wss.close(); } };
}

describe('ROS 2 Nav2 adapter (rosbridge)', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((f) => f()));

  it('maps the SLAM pose to the site grid, runs a route as one Nav2 goal and confirms from motion', async () => {
    const ros = fakeRosbridge();
    const a = new RosNav2Adapter({ deviceId: 'UGV-04', kind: 'ugv', url: `ws://127.0.0.1:${ros.port}`, indoor: { buildingId: 'B2', level: 1, positioning: 'slam' }, frame: { originX: 178, originY: 88 }, catalogId: 'D50' });
    expect(a.declaration.capabilities).toEqual(expect.arrayContaining(['indoor', 'lidar_slam', 'ground_patrol']));
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), ros.close);
    await until(() => got.telemetry.length > 0);
    const t0 = got.telemetry[0];
    expect(t0.pos).toEqual({ x: 180, y: 85 }); // map (2, 3): 2 m east, 3 m north of the origin
    expect(t0.level).toBe(1);
    expect(t0.battery).toBe(73);
    expect(t0.accuracyM).toBeCloseTo(0.2, 1);

    a.onCommand(cmd('start', { deviceId: 'UGV-04', route: [{ x: 181, y: 84 }, { x: 181, y: 80 }] }));
    await until(() => got.updates.some((u) => u.status === 'succeeded'), 8000);
    expect(ros.st.sent).toBe(1);
    expect(ros.st.goals.length + (ros.st.goalId ? 0 : 0)).toBeLessThanOrEqual(2);
    await until(() => got.events.some((e) => e.kind === 'route_complete'), 15000);
    expect(got.events.filter((e) => e.kind === 'checkpoint')).toHaveLength(2);
  }, 25_000);

  it('pauses by cancelling the goal and confirms only once the vehicle has stopped; resume re-sends the rest', async () => {
    const ros = fakeRosbridge();
    const a = new RosNav2Adapter({ deviceId: 'UGV-04', kind: 'ugv', url: `ws://127.0.0.1:${ros.port}`, frame: { originX: 178, originY: 88 } });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), ros.close);
    await until(() => got.telemetry.length > 0);
    a.onCommand(cmd('start', { deviceId: 'UGV-04', route: [{ x: 190, y: 70 }, { x: 200, y: 60 }] }));
    await until(() => got.updates.some((u) => u.status === 'succeeded'), 8000);
    a.onCommand(cmd('pause', { deviceId: 'UGV-04' }));
    await until(() => got.updates.filter((u) => u.status === 'succeeded').length === 2, 8000);
    expect(ros.st.cancelled).toBe(1);
    expect(ros.st.speed).toBe(0);
    a.onCommand(cmd('resume', { deviceId: 'UGV-04' }));
    await until(() => ros.st.sent === 2, 3000);
    await until(() => got.updates.filter((u) => u.status === 'succeeded').length === 3, 8000);
  }, 30_000);

  it('refuses commands while there is no pose from the vehicle', async () => {
    const a = new RosNav2Adapter({ deviceId: 'UGV-04', kind: 'ugv', url: 'ws://127.0.0.1:1', frame: { originX: 0, originY: 0 } });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop());
    a.onCommand(cmd('start', { deviceId: 'UGV-04', route: [{ x: 1, y: 1 }] }));
    await until(() => got.updates.length > 0);
    expect(got.updates[0]).toMatchObject({ status: 'rejected' });
  });
});
