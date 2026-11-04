import { describe, expect, it } from 'vitest';
import type { Incident, Mission, MissionStatus, Patrol } from '@13store/shared';
import { ROUTINE_TASK_TYPE } from '@13store/shared';
import { missionPurpose, missionQueue, myTurn, routeNumbers, stepIndex, upcomingRuns } from './missionPlanning';

const mission = (id: string, status: MissionStatus, extra: Partial<Mission> = {}): Mission => ({
  id,
  incidentId: `INC-${id}`,
  deviceId: 'UGV-01',
  operatorId: 'u-somchai',
  checkpoints: [
    { x: 0, y: 0 },
    { x: 30, y: 40 },
  ],
  planVersion: 1,
  status,
  nextCp: 0,
  createdAt: Number(id.replace(/\D/g, '')) * 1000,
  ...extra,
});
const users = [
  { id: 'u-alex', name: 'Alex Chen', role: 'dispatcher' as const, title: '' },
  { id: 'u-nida', name: 'Nida W.', role: 'supervisor' as const, title: '' },
  { id: 'u-somchai', name: 'Somchai K.', role: 'operator' as const, title: '' },
];
const alex = { id: 'u-alex', role: 'dispatcher' as const };
const nida = { id: 'u-nida', role: 'supervisor' as const };
const somchai = { id: 'u-somchai', role: 'operator' as const };

describe('mission planning queue', () => {
  it('asks each role for its own step only', () => {
    expect(myTurn(mission('M1', 'draft'), alex)).toMatch(/submit/);
    expect(myTurn(mission('M1', 'draft'), somchai)).toBeNull();
    // Supervisors may change drafts but are not asked to: their turn is the approval.
    expect(myTurn(mission('M1', 'draft'), nida)).toBeNull();
    expect(myTurn(mission('M2', 'pending_approval'), nida)).toMatch(/Approve/);
    // The operator of a mission never approves it (two-person rule).
    expect(myTurn(mission('M2', 'pending_approval', { operatorId: 'u-nida' }), nida)).toBeNull();
    expect(myTurn(mission('M3', 'approved', { approvedBy: 'u-nida' }), somchai)).toMatch(/Accept/);
    expect(myTurn(mission('M3', 'approved', { operatorId: 'u-nida', approvedBy: 'u-nida' }), nida)).toBeNull();
    expect(myTurn(mission('M4', 'paused'), somchai)).toMatch(/Resume/);
    expect(myTurn(mission('M5', 'completed'), alex)).toBeNull();
  });

  it('groups by who acts, keeps the oldest waiting job first, and searches', () => {
    const missions = [mission('M1', 'pending_approval'), mission('M2', 'executing'), mission('M3', 'completed'), mission('M4', 'pending_approval'), mission('M5', 'draft')];
    const q = missionQueue({ missions, incidents: [], users }, nida);
    expect(q.mine.map((x) => x.m.id)).toEqual(['M1', 'M4']);
    expect(q.running.map((x) => x.m.id)).toEqual(['M2']);
    expect(q.planning.map((x) => x.m.id)).toEqual(['M5']);
    expect(q.ended.map((x) => x.m.id)).toEqual(['M3']);
    expect(missionQueue({ missions, incidents: [], users }, nida, 'somchai').mine).toHaveLength(2);
    expect(missionQueue({ missions, incidents: [], users }, nida, 'm4').mine.map((x) => x.m.id)).toEqual(['M4']);
  });

  it('tells a routine task and a patrol run from an alert', () => {
    const inc = (id: string, extra: Partial<Incident>): Incident => ({
      id,
      title: 'x',
      type: 'Intrusion',
      severity: 'low',
      status: 'confirmed',
      zone: 'A',
      place: 'Gate',
      pos: { x: 0, y: 0 },
      source: 'test',
      createdAt: 0,
      thumb: 'path',
      ...extra,
    });
    const incidents = [inc('INC-M1', { type: ROUTINE_TASK_TYPE, title: 'Task: North fence', place: 'North fence' }), inc('INC-M2', { title: 'Patrol: Night loop', patrolId: 'P1' }), inc('INC-M3', { title: 'Gate alarm' })];
    expect(missionPurpose({ incidents }, mission('M1', 'draft'))).toMatchObject({ kind: 'task', title: 'North fence' });
    expect(missionPurpose({ incidents }, mission('M2', 'draft', { patrolId: 'P1' }))).toMatchObject({ kind: 'patrol', title: 'Night loop' });
    expect(missionPurpose({ incidents }, mission('M3', 'draft'))).toMatchObject({ kind: 'incident', title: 'Gate alarm' });
  });

  it('places each status on the planning steps', () => {
    expect(stepIndex('draft')).toBe(2);
    expect(stepIndex('pending_approval')).toBe(3);
    expect(stepIndex('approved')).toBe(4);
    expect(stepIndex('executing')).toBe(5);
    expect(stepIndex('completed')).toBe(7);
  });

  it('adds up a route from the vehicle at its route speed', () => {
    const n = routeNumbers(
      [
        { x: 30, y: 40, holdS: 10, capture: true },
        { x: 30, y: 80 },
      ],
      { pos: { x: 0, y: 0 }, routeSpeed: 1, integration: 'verified' },
    );
    expect(n).toMatchObject({ checkpoints: 2, lengthM: 90, speed: 1, captures: 1, waitS: 10 });
    expect(n.timeS).toBe(100);
  });
});

describe('upcoming patrol runs', () => {
  const patrol = (extra: Partial<Patrol>): Patrol => ({
    id: 'P1',
    name: 'Night loop',
    deviceId: 'UGV-01',
    operatorId: 'u-somchai',
    route: [],
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ['22:00', '02:00'],
    enabled: true,
    autoStart: false,
    createdBy: 'u-nida',
    createdAt: 0,
    ...extra,
  });

  it('lists the runs of the next days soonest first, from now on, and skips disabled schedules', () => {
    const now = new Date(2026, 10, 4, 23, 0).getTime(); // Wednesday 23:00
    const runs = upcomingRuns([patrol({}), patrol({ id: 'P2', enabled: false })], now, 3);
    expect(runs.map((r) => new Date(r.at).toTimeString().slice(0, 5))).toEqual(['02:00', '22:00', '02:00', '22:00']);
    expect(runs.every((r) => r.patrol.id === 'P1' && r.at > now)).toBe(true);
    // Only on the schedule's days: Thursday (4) alone.
    const thu = upcomingRuns([patrol({ days: [4], times: ['08:30'] })], now, 7);
    expect(thu).toHaveLength(1);
    expect(new Date(thu[0].at).getDay()).toBe(4);
  });
});
