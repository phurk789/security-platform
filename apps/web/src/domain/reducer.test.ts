import { describe, expect, it } from 'vitest';
import { makeInitialState, missionForIncident, reducer, type Msg } from './reducer';
import { freshness } from './policy';
import { DEFAULT_ROUTE } from './scenario';
import type { AppState } from '@13store/shared';

const ALT_ROUTE = [
  { x: 262, y: 200 },
  { x: 334, y: 228 },
];

function run(s: AppState, ...msgs: Msg[]) {
  return msgs.reduce(reducer, s);
}
function as(userId: string): Msg {
  return { type: 'setUser', userId };
}
function advance(s: AppState, ms: number, step = 250) {
  for (let t = 0; t < ms; t += step) s = reducer(s, { type: 'tick', dt: step });
  return s;
}

/** Walk INC-024 to an approved, accepted mission ready to start. */
function readyToStart() {
  let s = makeInitialState();
  s = run(
    s,
    { type: 'openCamera', incidentId: 'INC-024' },
    { type: 'confirmIncident', incidentId: 'INC-024' },
    { type: 'createMission', incidentId: 'INC-024', deviceId: 'UGV-01', operatorId: 'u-somchai', checkpoints: DEFAULT_ROUTE },
  );
  const m = missionForIncident(s, 'INC-024')!;
  s = run(s, { type: 'submitMission', missionId: m.id }, as('u-nida'), { type: 'approveMission', missionId: m.id }, as('u-somchai'), {
    type: 'acceptMission',
    missionId: m.id,
  });
  return { s, id: m.id };
}

describe('incident flow', () => {
  it('moves New → Triaging → Confirmed and records actor and time', () => {
    let s = run(makeInitialState(), { type: 'openCamera', incidentId: 'INC-024' });
    expect(s.incidents.find((i) => i.id === 'INC-024')!.status).toBe('triaging');
    s = run(s, { type: 'confirmIncident', incidentId: 'INC-024' });
    expect(s.incidents.find((i) => i.id === 'INC-024')!.status).toBe('confirmed');
    const last = s.audit[s.audit.length - 1];
    expect(last).toMatchObject({ actor: 'Alex Chen', action: 'incident.confirm', result: 'ok' });
  });

  it('merges a duplicate without losing the original evidence', () => {
    let s = run(makeInitialState(), { type: 'demoInjectAlert' });
    const dupe = s.incidents[0];
    const before = s.evidence.length;
    s = run(s, { type: 'mergeIncident', incidentId: dupe.id, intoId: 'INC-024', reason: 'Same sensor, same minute' });
    expect(s.incidents.find((i) => i.id === dupe.id)!).toMatchObject({ status: 'duplicate', duplicateOf: 'INC-024' });
    expect(s.evidence.length).toBe(before);
  });

  it('requires a reason to dismiss', () => {
    const s = run(makeInitialState(), { type: 'dismissIncident', incidentId: 'INC-024', reason: '  ' });
    expect(s.incidents.find((i) => i.id === 'INC-024')!.status).toBe('new');
  });
});

describe('permissions (server-side re-check)', () => {
  it('a dispatcher cannot approve a mission even by sending the message directly', () => {
    let s = makeInitialState();
    s = run(
      s,
      { type: 'openCamera', incidentId: 'INC-024' },
      { type: 'confirmIncident', incidentId: 'INC-024' },
      { type: 'createMission', incidentId: 'INC-024', deviceId: 'UGV-01', operatorId: 'u-somchai', checkpoints: DEFAULT_ROUTE },
    );
    const m = missionForIncident(s, 'INC-024')!;
    s = run(s, { type: 'submitMission', missionId: m.id }, { type: 'approveMission', missionId: m.id });
    expect(missionForIncident(s, 'INC-024')!.status).toBe('pending_approval');
    expect(s.audit[s.audit.length - 1]).toMatchObject({ action: 'mission.approve', result: 'denied' });
  });

  it('an auditor cannot send device commands', () => {
    const { s: ready, id } = readyToStart();
    const s = run(ready, as('u-priya'), { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    expect(s.commands).toHaveLength(0);
    expect(s.audit[s.audit.length - 1].result).toBe('denied');
  });

  it('a supervisor without control cannot command the vehicle (control lock)', () => {
    const { s: ready, id } = readyToStart();
    const s = run(ready, as('u-nida'), { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    expect(s.commands.every((c) => c.status !== 'authorized')).toBe(true);
  });

  it('records control handover', () => {
    const { s: ready } = readyToStart();
    const s = run(ready, as('u-nida'), { type: 'handover', deviceId: 'UGV-01', toUserId: 'u-nida' });
    expect(s.devices['UGV-01'].controlOwner).toBe('u-nida');
    expect(s.audit[s.audit.length - 1]).toMatchObject({ action: 'control.handover', result: 'ok' });
  });
});

describe('mission approval', () => {
  it('editing the route after approval forces re-approval', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, as('u-alex'), { type: 'editRoute', missionId: id, checkpoints: ALT_ROUTE });
    expect(missionForIncident(s, 'INC-024')!.status).toBe('pending_approval');
    s = run(s, as('u-somchai'), { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    expect(s.commands.find((c) => c.idempotencyKey === 'k1')!.status).toBe('rejected');
  });
});

describe('commands', () => {
  it('start is only confirmed after the device responds, then the vehicle moves', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    expect(s.commands[0].status).toBe('authorized');
    expect(missionForIncident(s, 'INC-024')!.status).toBe('assigned');
    s = advance(s, 2500);
    expect(s.commands[0].status).toBe('succeeded');
    expect(missionForIncident(s, 'INC-024')!.status).toBe('executing');
    const p0 = s.devices['UGV-01'].pos;
    s = advance(s, 3000);
    expect(s.devices['UGV-01'].pos).not.toEqual(p0);
  });

  it('retrying with the same idempotency key does not create a second command', () => {
    const { s: ready, id } = readyToStart();
    const cmd: Msg = { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'same' };
    const s = run(ready, cmd, cmd, cmd);
    expect(s.commands).toHaveLength(1);
  });

  it('a stop request without acknowledgement times out instead of showing success', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    s = advance(s, 3000);
    s = run(s, { type: 'demoCutLink', deviceId: 'UGV-01' }, { type: 'issueCommand', missionId: id, command: 'stop', idempotencyKey: 'k2' });
    s = advance(s, 6000);
    const stop = s.commands.find((c) => c.idempotencyKey === 'k2')!;
    expect(stop.status).toBe('timed_out');
    expect(missionForIncident(s, 'INC-024')!.status).not.toBe('cancelled');
  });
});

describe('stale data and reconnect', () => {
  it('marks telemetry stale and blocks new start/resume commands', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'demoCutLink', deviceId: 'UGV-01' });
    s = advance(s, 6000);
    expect(freshness(s, s.devices['UGV-01'])).toBe('stale');
    s = run(s, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    expect(s.commands[0].status).toBe('rejected');
  });

  it('after reconnect, old commands are not replayed and the mission does not resume by itself', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    s = advance(s, 3000);
    s = run(s, { type: 'demoCutLink', deviceId: 'UGV-01' }, { type: 'issueCommand', missionId: id, command: 'pause', idempotencyKey: 'k2' });
    // Longer than the vehicle's 1.5 s failsafe delay plus braking time.
    s = advance(s, 3500);
    s = run(s, { type: 'demoRestoreLink', deviceId: 'UGV-01' });
    s = advance(s, 1500);
    const pause = s.commands.find((c) => c.idempotencyKey === 'k2')!;
    expect(pause.delivered).toBe(false);
    expect(pause.status).toBe('timed_out');
    expect(missionForIncident(s, 'INC-024')!.status).toBe('paused');
    // After reconnect the vehicle stays put: reported speed 0, fixes only jitter by GNSS noise.
    const atReconnect = s.devices['UGV-01'].pos;
    s = advance(s, 4000);
    expect(s.devices['UGV-01'].speed).toBe(0);
    expect(s.sim!['UGV-01'].motion.speed).toBe(0);
    const p = s.devices['UGV-01'].pos;
    expect(Math.hypot(p.x - atReconnect.x, p.y - atReconnect.y)).toBeLessThan(3);
    expect(missionForIncident(s, 'INC-024')!.status).toBe('paused');
  });

  it('a link blip shorter than the failsafe delay does not stop the vehicle', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    s = advance(s, 3000);
    s = run(s, { type: 'demoCutLink', deviceId: 'UGV-01' });
    s = advance(s, 1000);
    s = run(s, { type: 'demoRestoreLink', deviceId: 'UGV-01' });
    s = advance(s, 1500);
    expect(missionForIncident(s, 'INC-024')!.status).toBe('executing');
    expect(s.devices['UGV-01'].speed).toBeGreaterThan(0);
  });

  it('pause is confirmed only after the vehicle has braked to a stop', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    s = advance(s, 6000);
    expect(s.sim!['UGV-01'].motion.speed).toBeGreaterThan(3);
    s = run(s, { type: 'issueCommand', missionId: id, command: 'pause', idempotencyKey: 'p1' });
    s = advance(s, 1250);
    const pending = s.commands.find((c) => c.idempotencyKey === 'p1')!;
    expect(pending.status).toBe('executing');
    expect(missionForIncident(s, 'INC-024')!.status).toBe('executing');
    s = advance(s, 3000);
    expect(s.commands.find((c) => c.idempotencyKey === 'p1')!.status).toBe('succeeded');
    expect(s.sim!['UGV-01'].motion.speed).toBe(0);
    expect(missionForIncident(s, 'INC-024')!.status).toBe('paused');
  });

  it('telemetry carries heading, link quality, satellites, accuracy and latency', () => {
    let s = advance(makeInitialState(), 3000);
    const d = s.devices['UGV-01'];
    expect(d.signal).toBeGreaterThan(20);
    expect(d.satellites).toBeGreaterThan(5);
    expect(d.latencyMs).toBeGreaterThanOrEqual(45);
    expect(d.accuracyM).toBeGreaterThanOrEqual(0.8);
    expect(d.accuracyM).toBeLessThanOrEqual(2.5);
    s = advance(s, 2000);
    const samples = s.telemetry.filter((t) => t.deviceId === 'UGV-01');
    expect(samples.length).toBeGreaterThan(2);
    expect(samples[samples.length - 1].signal).toBeGreaterThan(0);
  });
});

describe('replay', () => {
  it('blocks device commands while in replay', () => {
    const { s: ready, id } = readyToStart();
    const s = run(ready, { type: 'enterReplay', at: ready.now - 60_000 }, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    expect(s.commands).toHaveLength(0);
    expect(s.audit[s.audit.length - 1]).toMatchObject({ result: 'denied', detail: 'replay mode' });
  });
});

describe('full run', () => {
  it('completes the mission, attaches evidence, and closes the incident', () => {
    const { s: ready, id } = readyToStart();
    let s = run(ready, { type: 'issueCommand', missionId: id, command: 'start', idempotencyKey: 'k1' });
    s = advance(s, 40_000, 500);
    expect(missionForIncident(s, 'INC-024')!.status).toBe('completed');
    expect(s.evidence.some((e) => e.source === 'UGV-01')).toBe(true);
    s = run(s, as('u-alex'), { type: 'resolveIncident', incidentId: 'INC-024', outcome: 'Gate secured. No intrusion found.' }, { type: 'closeIncident', incidentId: 'INC-024' });
    expect(s.incidents.find((i) => i.id === 'INC-024')!.status).toBe('closed');
  });
});
