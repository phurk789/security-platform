// Mission planning page logic, kept apart from the view so it can be tested: who has to act on a
// mission, how missions are grouped in the queue, where a mission is in the planning steps, what a
// route adds up to, and when the patrol schedules run next.
import { REAL_ROUTE_SPEED, ROUTINE_TASK_TYPE, can, routeLength, routeSpeedOf, routeTimeS } from '@13store/shared';
import type { AppState, Device, Incident, Mission, MissionStatus, Patrol, Role, RoutePoint } from '@13store/shared';

export const PLANNING: MissionStatus[] = ['draft', 'rejected', 'pending_approval', 'approved'];
export const RUNNING: MissionStatus[] = ['assigned', 'executing', 'paused'];
export const ENDED: MissionStatus[] = ['completed', 'failed', 'cancelled'];

/** The person looking at the page. */
export interface Viewer {
  id: string;
  role: Role;
}

/** What this person has to do on the mission now (an English label to translate), if anything. */
export function myTurn(m: Mission, me: Viewer): string | null {
  // Drafts are the preparers' job (dispatchers); approvers may change them too, but are not asked to.
  if ((m.status === 'draft' || m.status === 'rejected') && can(me.role, 'mission.prepare') && !can(me.role, 'mission.approve'))
    return m.status === 'rejected' ? 'Fix the plan and submit it again' : 'Check the plan and submit it for approval';
  // Two-person rule: the operator of a mission does not approve it.
  if (m.status === 'pending_approval' && can(me.role, 'mission.approve') && m.operatorId !== me.id) return 'Approve or reject the plan';
  if (m.status === 'approved' && m.operatorId === me.id && m.approvedBy !== me.id && can(me.role, 'mission.accept')) return 'Accept the mission and take control';
  if (m.status === 'assigned' && m.operatorId === me.id) return 'Start the route';
  if (m.status === 'paused' && m.operatorId === me.id) return 'Resume or stop the route';
  return null;
}

export type MissionKind = 'incident' | 'task' | 'patrol';

/** What the mission is for: an alert, a routine task or a patrol run, and the name to show. */
export function missionPurpose(s: Pick<AppState, 'incidents'>, m: Mission): { kind: MissionKind; title: string; inc?: Incident } {
  const inc = s.incidents.find((i) => i.id === m.incidentId);
  if (!inc) return { kind: m.patrolId ? 'patrol' : 'incident', title: m.incidentId };
  if (inc.type === ROUTINE_TASK_TYPE) return { kind: 'task', title: inc.place, inc };
  if (m.patrolId || inc.patrolId) return { kind: 'patrol', title: inc.title.replace(/^Patrol: /, ''), inc };
  return { kind: 'incident', title: inc.title, inc };
}

export interface QueueItem {
  m: Mission;
  turn: string | null;
}

export interface Queue {
  /** Needs this person's action, oldest first. */
  mine: QueueItem[];
  /** Assigned, driving or held: newest first. */
  running: QueueItem[];
  /** Drafts and plans waiting on someone else: newest first. */
  planning: QueueItem[];
  /** Completed, failed or cancelled: newest first. */
  ended: QueueItem[];
}

/** The queue on the left of the page, filtered by a search over id, purpose, vehicle and operator name. */
export function missionQueue(s: Pick<AppState, 'missions' | 'incidents' | 'users'>, me: Viewer, query = ''): Queue {
  const q = query.trim().toLowerCase();
  const name = (id: string) => s.users.find((u) => u.id === id)?.name ?? id;
  const match = (m: Mission) => !q || `${m.id} ${missionPurpose(s, m).title} ${m.incidentId} ${m.deviceId} ${name(m.operatorId)}`.toLowerCase().includes(q);
  const out: Queue = { mine: [], running: [], planning: [], ended: [] };
  for (const m of s.missions) {
    if (!match(m)) continue;
    const turn = myTurn(m, me);
    const item = { m, turn };
    if (turn) out.mine.push(item);
    else if (RUNNING.includes(m.status)) out.running.push(item);
    else if (ENDED.includes(m.status)) out.ended.push(item);
    else out.planning.push(item);
  }
  const newest = (a: QueueItem, b: QueueItem) => b.m.createdAt - a.m.createdAt;
  out.mine.sort((a, b) => a.m.createdAt - b.m.createdAt);
  out.running.sort(newest);
  out.planning.sort(newest);
  out.ended.sort(newest);
  return out;
}

/** The planning steps, in order (English labels to translate). */
export const STEPS = ['Vehicle', 'Route', 'Checks', 'Approval', 'Operator accepts', 'Running', 'Finished'] as const;

/** The step a mission is at: earlier steps are done. Finished missions are past the last step. */
export function stepIndex(status: MissionStatus): number {
  switch (status) {
    case 'draft':
    case 'rejected':
      return 2;
    case 'pending_approval':
      return 3;
    case 'approved':
      return 4;
    case 'assigned':
    case 'executing':
    case 'paused':
      return 5;
    default:
      return STEPS.length;
  }
}

export interface RouteNumbers {
  checkpoints: number;
  lengthM: number;
  timeS: number;
  speed: number;
  captures: number;
  waitS: number;
}

/** What a route adds up to for this vehicle (from where it is, at its route speed), or at 1 m/s without one. */
export function routeNumbers(points: RoutePoint[], d?: Pick<Device, 'pos' | 'noFix' | 'routeSpeed' | 'integration' | 'indoor'>): RouteNumbers {
  const from = d && !d.noFix ? d.pos : undefined;
  const speed = d ? routeSpeedOf(d) : REAL_ROUTE_SPEED;
  return {
    checkpoints: points.length,
    lengthM: Math.round(routeLength(points, from)),
    timeS: routeTimeS(points, from, speed),
    speed,
    captures: points.filter((p) => p.capture).length,
    waitS: points.reduce((a, p) => a + (p.holdS ?? 0), 0),
  };
}

export interface PatrolRun {
  at: number;
  patrol: Patrol;
}

/** Patrol runs due from `now` over the next `days` days (local time), soonest first. */
export function upcomingRuns(patrols: Patrol[], now: number, days = 7, limit = 30): PatrolRun[] {
  const out: PatrolRun[] = [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (const p of patrols) {
    if (!p.enabled) continue;
    for (let k = 0; k < days; k++) {
      const day = new Date(start);
      day.setDate(start.getDate() + k);
      if (!p.days.includes(day.getDay())) continue;
      for (const hm of p.times) {
        const [h, mi] = hm.split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(mi)) continue;
        const at = new Date(day);
        at.setHours(h, mi, 0, 0);
        if (at.getTime() > now) out.push({ at: at.getTime(), patrol: p });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}
