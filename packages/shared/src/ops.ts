// Command-centre operations shared by server and console: SOP playbooks with SLA stages,
// per-incident SLA state, outbound notification channel types and KPI computation.
import type { Incident, Mission, Role, TimelineEvent } from './types';

// ---------------------------------------------------------------------------
// Playbooks (standard operating procedures) and SLA stages
// ---------------------------------------------------------------------------

export type SlaStage = 'acknowledge' | 'verify' | 'respond' | 'resolve';
export const SLA_STAGES: SlaStage[] = ['acknowledge', 'verify', 'respond', 'resolve'];
export const SLA_STAGE_LABEL: Record<SlaStage, string> = { acknowledge: 'Acknowledge', verify: 'Verify', respond: 'Respond', resolve: 'Resolve' };

export interface PlaybookStep {
  id: string;
  title: string;
  detail?: string;
  /** Who normally does it (information for the operator, not enforced). */
  role?: Role;
}

export interface Playbook {
  id: string;
  name: string;
  /** First playbook whose match fits the incident is used; an empty match fits everything. */
  match: { types?: string[]; severities?: Incident['severity'][]; sourceContains?: string };
  steps: PlaybookStep[];
  /** Minutes allowed per stage from the alert (0 = no limit). */
  sla: Record<SlaStage, number>;
}

export interface ChecklistItem {
  id: string;
  title: string;
  detail?: string;
  role?: Role;
  doneAt?: number;
  by?: string;
}

export const DEFAULT_PLAYBOOKS: Playbook[] = [
  {
    id: 'fire',
    name: 'Fire, smoke or thermal hotspot',
    match: { types: ['Detection: Fire', 'Detection: Smoke', 'Detection: Thermal hotspot', 'Fire alarm'] },
    steps: [
      { id: 'verify-thermal', title: 'Verify on the thermal camera and a second view', role: 'dispatcher' },
      { id: 'call-fire', title: 'Call the fire brigade (199) and the site fire warden', detail: 'Give building, side and what the camera shows.', role: 'dispatcher' },
      { id: 'dispatch-ugv', title: 'Dispatch the nearest vehicle with a camera to the spot', role: 'dispatcher' },
      { id: 'keep-clear', title: 'Keep people away: announcement and warning light', role: 'operator' },
      { id: 'notify-fm', title: 'Notify the facility manager and switch off power if asked', role: 'supervisor' },
      { id: 'record', title: 'Record the outcome, cause and damage with photos', role: 'dispatcher' },
    ],
    sla: { acknowledge: 1, verify: 3, respond: 5, resolve: 90 },
  },
  {
    id: 'intrusion',
    name: 'Intrusion or person in a protected area',
    match: { types: ['Detection: Person', 'Detection: Intrusion', 'Detection: Loitering', 'Sensor alert', 'Access obstruction'] },
    steps: [
      { id: 'verify-camera', title: 'Open the nearest camera and confirm what triggered the alert', role: 'dispatcher' },
      { id: 'announce', title: 'Announce from the vehicle or camera speaker before approaching', role: 'operator' },
      { id: 'dispatch', title: 'Dispatch a vehicle or a responder to the place', role: 'dispatcher' },
      { id: 'identify', title: 'Identify the person; call the police (191) if the intrusion continues', role: 'supervisor' },
      { id: 'secure', title: 'Secure the gate or door and check for damage', role: 'responder' },
      { id: 'record', title: 'Record the outcome with evidence', role: 'dispatcher' },
    ],
    sla: { acknowledge: 2, verify: 5, respond: 10, resolve: 60 },
  },
  {
    id: 'equipment',
    name: 'Equipment fault or camera offline',
    match: { types: ['Equipment fault', 'Equipment offline', 'Camera offline'] },
    steps: [
      { id: 'check-power', title: 'Check power and network to the device', role: 'operator' },
      { id: 'cover', title: 'Cover the area with another camera or a vehicle', role: 'dispatcher' },
      { id: 'ticket', title: 'Raise a maintenance ticket with the device id and symptoms', role: 'dispatcher' },
    ],
    sla: { acknowledge: 5, verify: 15, respond: 0, resolve: 480 },
  },
  {
    id: 'default',
    name: 'General alert',
    match: {},
    steps: [
      { id: 'verify', title: 'Verify from a camera or a person on site', role: 'dispatcher' },
      { id: 'respond', title: 'Dispatch a vehicle or responder if confirmed', role: 'dispatcher' },
      { id: 'record', title: 'Record the outcome', role: 'dispatcher' },
    ],
    sla: { acknowledge: 3, verify: 10, respond: 20, resolve: 120 },
  },
];

export function pickPlaybook(books: Playbook[], inc: Pick<Incident, 'type' | 'severity' | 'source'>): Playbook | undefined {
  return books.find((b) => {
    const m = b.match;
    if (m.types?.length && !m.types.some((t) => inc.type === t || inc.type.startsWith(t))) return false;
    if (m.severities?.length && !m.severities.includes(inc.severity)) return false;
    if (m.sourceContains && !inc.source.toLowerCase().includes(m.sourceContains.toLowerCase())) return false;
    return true;
  });
}

export type StageStatus = 'met' | 'running' | 'at_risk' | 'breached' | 'na';

export interface StageState {
  stage: SlaStage;
  limitMin: number;
  dueAt: number;
  doneAt?: number;
  status: StageStatus;
}

const ACK_TITLES = [/^Camera opened/, /^Operator reviewing/, /^Verified/, /^Confirmed/, /^Dismissed/, /^Merged/, /^Marked duplicate/, /^Patrol/];
const VERIFY_TITLES = [/^Verified/, /^Confirmed/, /^Dismissed/, /^Merged/, /^Marked duplicate/, /^Mission approved \(standing approval\)/];
const RESPOND_TITLES = [/^Mission .* started$/, /^Assigned to /, /^Operator assigned by schedule/];
const RESOLVE_TITLES = [/^Resolved/, /^Closed/, /^Dismissed/, /^Merged/, /^Marked duplicate/, /^Patrol completed/];

function firstAt(events: TimelineEvent[], res: RegExp[]) {
  let best: number | undefined;
  for (const e of events) if (res.some((r) => r.test(e.title)) && (best === undefined || e.at < best)) best = e.at;
  return best;
}

/** SLA state of each stage for one incident, from its timeline. */
export function slaStages(inc: Incident, events: TimelineEvent[], limits: Record<SlaStage, number>, now: number): StageState[] {
  const own = events.filter((e) => e.incidentId === inc.id);
  const terminalEarly = inc.status === 'dismissed' || inc.status === 'duplicate';
  const done: Record<SlaStage, number | undefined> = {
    acknowledge: inc.status === 'new' ? undefined : (firstAt(own, ACK_TITLES) ?? inc.createdAt),
    verify: ['new', 'triaging'].includes(inc.status) ? undefined : (firstAt(own, VERIFY_TITLES) ?? firstAt(own, RESPOND_TITLES)),
    respond: firstAt(own, RESPOND_TITLES),
    resolve: ['resolved', 'closed', 'dismissed', 'duplicate'].includes(inc.status) ? (firstAt(own, RESOLVE_TITLES) ?? now) : undefined,
  };
  return SLA_STAGES.map((stage) => {
    const limitMin = limits[stage] ?? 0;
    const dueAt = inc.createdAt + limitMin * 60_000;
    const doneAt = done[stage];
    let status: StageStatus;
    if (limitMin <= 0 || (terminalEarly && (stage === 'respond' || stage === 'resolve') && !doneAt)) status = 'na';
    else if (doneAt !== undefined) status = doneAt <= dueAt ? 'met' : 'breached';
    else if (now > dueAt) status = 'breached';
    else if (now > dueAt - Math.max(30_000, limitMin * 60_000 * 0.25)) status = 'at_risk';
    else status = 'running';
    return { stage, limitMin, dueAt, doneAt, status };
  });
}

/** Worst stage status, for a badge. */
export function slaSummary(stages: StageState[]): StageStatus {
  if (stages.some((s) => s.status === 'breached')) return 'breached';
  if (stages.some((s) => s.status === 'at_risk')) return 'at_risk';
  if (stages.some((s) => s.status === 'running')) return 'running';
  return stages.some((s) => s.status === 'met') ? 'met' : 'na';
}

// ---------------------------------------------------------------------------
// Outbound notifications
// ---------------------------------------------------------------------------

export type NotifyEvent =
  | 'incident.new'
  | 'incident.confirmed'
  | 'incident.resolved'
  | 'sla.breach'
  | 'geofence.breach'
  | 'detection.incident'
  | 'patrol.skipped'
  | 'device.offline';
export const NOTIFY_EVENTS: NotifyEvent[] = [
  'incident.new',
  'incident.confirmed',
  'incident.resolved',
  'sla.breach',
  'geofence.breach',
  'detection.incident',
  'patrol.skipped',
  'device.offline',
];
export const NOTIFY_EVENT_LABEL: Record<NotifyEvent, string> = {
  'incident.new': 'New alert',
  'incident.confirmed': 'Alert confirmed',
  'incident.resolved': 'Incident resolved',
  'sla.breach': 'SLA breached',
  'geofence.breach': 'Geofence breach',
  'detection.incident': 'AI detection raised an incident',
  'patrol.skipped': 'Patrol skipped',
  'device.offline': 'Device offline',
};

export type ChannelKind = 'webhook' | 'line' | 'sms';

export interface NotificationChannel {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  events: NotifyEvent[];
  /** Incident events below this severity are not sent (other events always are). */
  minSeverity?: Incident['severity'];
  /** HTTPS endpoint; JSON body signed with HMAC-SHA256 in X-PST-Signature when a secret is set. */
  webhook?: { url: string; secret?: string };
  /** LINE Messaging API push: channel access token and the user/group/room id to push to. */
  line?: { token: string; to: string };
  /** Any HTTP SMS gateway: URL and optional body template with {to} and {text}. */
  sms?: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; to: string[] };
}

/** Delivery record kept for the administrator. */
export interface NotificationDelivery {
  id: string;
  at: number;
  channelId: string;
  channelName: string;
  kind: ChannelKind;
  event: NotifyEvent;
  title: string;
  status: 'sent' | 'failed';
  attempts: number;
  detail?: string;
  incidentId?: string;
}

export const SEVERITY_RANK: Record<Incident['severity'], number> = { low: 0, medium: 1, high: 2 };

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export interface KpiInput {
  from: number;
  to: number;
  incidents: Incident[];
  timeline: TimelineEvent[];
  missions: Mission[];
  playbooks: Playbook[];
  detections?: { type: string; outcome: string; at: number }[];
  patrolRuns?: { ok: boolean; at: number }[];
  now: number;
}

export interface Kpi {
  from: number;
  to: number;
  incidents: {
    total: number;
    open: number;
    byStatus: Record<string, number>;
    byType: { type: string; n: number }[];
    bySeverity: Record<string, number>;
    byZone: { zone: string; n: number }[];
    perDay: { day: string; n: number }[];
    byHour: number[];
    falseAlarmPct: number;
  };
  response: Record<SlaStage, { p50: number | null; p90: number | null; n: number }>;
  sla: { measured: number; met: number; breached: number; compliancePct: number | null; byStage: Record<SlaStage, { met: number; breached: number }> };
  missions: { total: number; completed: number; cancelled: number; failed: number; patrols: number };
  detections?: { total: number; byOutcome: Record<string, number>; byType: { type: string; n: number }[] };
  patrols?: { runs: number; skipped: number };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

function dayKey(at: number, tz = 'Asia/Bangkok') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

function hourOf(at: number, tz = 'Asia/Bangkok') {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(at))) % 24;
  } catch {
    return new Date(at).getUTCHours();
  }
}

const top = (counts: Record<string, number>, n: number, key: string) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ [key]: k, n: v }));

/** Operational KPIs for a period. Same code on the server (full data) and in the console (what it holds). */
export function computeKpi(input: KpiInput, tz = 'Asia/Bangkok'): Kpi {
  const inRange = input.incidents.filter((i) => i.createdAt >= input.from && i.createdAt <= input.to);
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byZone: Record<string, number> = {};
  const perDay: Record<string, number> = {};
  const byHour = new Array<number>(24).fill(0);
  for (const i of inRange) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    byType[i.type] = (byType[i.type] ?? 0) + 1;
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    byZone[i.zone] = (byZone[i.zone] ?? 0) + 1;
    const d = dayKey(i.createdAt, tz);
    perDay[d] = (perDay[d] ?? 0) + 1;
    byHour[hourOf(i.createdAt, tz)]++;
  }
  // Every day of the period appears, even with zero alerts.
  const days: { day: string; n: number }[] = [];
  for (let t = input.from; t <= input.to && days.length < 400; t += 86_400_000) {
    const d = dayKey(t, tz);
    if (!days.some((x) => x.day === d)) days.push({ day: d, n: perDay[d] ?? 0 });
  }
  const lastDay = dayKey(input.to, tz);
  if (!days.some((x) => x.day === lastDay)) days.push({ day: lastDay, n: perDay[lastDay] ?? 0 });

  const response: Kpi['response'] = {
    acknowledge: { p50: null, p90: null, n: 0 },
    verify: { p50: null, p90: null, n: 0 },
    respond: { p50: null, p90: null, n: 0 },
    resolve: { p50: null, p90: null, n: 0 },
  };
  const samples: Record<SlaStage, number[]> = { acknowledge: [], verify: [], respond: [], resolve: [] };
  const sla: Kpi['sla'] = {
    measured: 0,
    met: 0,
    breached: 0,
    compliancePct: null,
    byStage: { acknowledge: { met: 0, breached: 0 }, verify: { met: 0, breached: 0 }, respond: { met: 0, breached: 0 }, resolve: { met: 0, breached: 0 } },
  };
  for (const i of inRange) {
    if (i.patrolId) continue; // patrols are not alerts
    const book = pickPlaybook(input.playbooks, i);
    const stages = slaStages(i, input.timeline, book?.sla ?? { acknowledge: 0, verify: 0, respond: 0, resolve: 0 }, input.now);
    for (const st of stages) {
      if (st.doneAt !== undefined) samples[st.stage].push((st.doneAt - i.createdAt) / 60_000);
      if (st.status === 'met' || st.status === 'breached') {
        sla.measured++;
        if (st.status === 'met') {
          sla.met++;
          sla.byStage[st.stage].met++;
        } else {
          sla.breached++;
          sla.byStage[st.stage].breached++;
        }
      }
    }
  }
  for (const stage of SLA_STAGES) response[stage] = { p50: round1(percentile(samples[stage], 50)), p90: round1(percentile(samples[stage], 90)), n: samples[stage].length };
  sla.compliancePct = sla.measured ? Math.round((sla.met / sla.measured) * 1000) / 10 : null;

  const ids = new Set(inRange.map((i) => i.id));
  const missions = input.missions.filter((m) => ids.has(m.incidentId));
  const falseAlarms = inRange.filter((i) => i.status === 'dismissed' || i.status === 'duplicate').length;
  const out: Kpi = {
    from: input.from,
    to: input.to,
    incidents: {
      total: inRange.length,
      open: inRange.filter((i) => !['closed', 'dismissed', 'duplicate'].includes(i.status)).length,
      byStatus,
      byType: top(byType, 8, 'type') as { type: string; n: number }[],
      bySeverity,
      byZone: top(byZone, 6, 'zone') as { zone: string; n: number }[],
      perDay: days,
      byHour,
      falseAlarmPct: inRange.length ? Math.round((falseAlarms / inRange.length) * 1000) / 10 : 0,
    },
    response,
    sla,
    missions: {
      total: missions.length,
      completed: missions.filter((m) => m.status === 'completed').length,
      cancelled: missions.filter((m) => m.status === 'cancelled').length,
      failed: missions.filter((m) => m.status === 'failed').length,
      patrols: missions.filter((m) => m.patrolId).length,
    },
  };
  if (input.detections) {
    const det = input.detections.filter((d) => d.at >= input.from && d.at <= input.to);
    const byOutcome: Record<string, number> = {};
    const dType: Record<string, number> = {};
    for (const d of det) {
      byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
      dType[d.type] = (dType[d.type] ?? 0) + 1;
    }
    out.detections = { total: det.length, byOutcome, byType: top(dType, 8, 'type') as { type: string; n: number }[] };
  }
  if (input.patrolRuns) {
    const runs = input.patrolRuns.filter((r) => r.at >= input.from && r.at <= input.to);
    out.patrols = { runs: runs.length, skipped: runs.filter((r) => !r.ok).length };
  }
  return out;
}

const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

const fmtMin = (v: number | null) => (v === null ? '—' : v < 1 ? `${Math.round(v * 60)} s` : `${v.toFixed(1)} min`);

/** Markdown monthly / period report from the KPIs. */
export function kpiMarkdown(k: Kpi, opts: { title: string; org: string; generatedBy: string; dataLabel: string; fmtDate: (t: number) => string }): string {
  const lines = [
    `# ${opts.title}`,
    '',
    opts.dataLabel !== 'LIVE'
      ? `> ${opts.dataLabel} DATA — generated by the 13STORE Public Security Twin. Not an operational record.`
      : '> Generated by the 13STORE Public Security Twin.',
    '',
    `- Organisation: ${opts.org}`,
    `- Period: ${opts.fmtDate(k.from)} – ${opts.fmtDate(k.to)}`,
    `- Generated by: ${opts.generatedBy}`,
    '',
    '## Alerts and incidents',
    `- Total: ${k.incidents.total} (open at period end: ${k.incidents.open})`,
    `- False alarms (dismissed or duplicate): ${k.incidents.falseAlarmPct}%`,
    `- By severity: ${
      Object.entries(k.incidents.bySeverity)
        .map(([s, n]) => `${s} ${n}`)
        .join(', ') || '—'
    }`,
    `- By status: ${
      Object.entries(k.incidents.byStatus)
        .map(([s, n]) => `${s} ${n}`)
        .join(', ') || '—'
    }`,
    '',
    '| Type | Incidents |',
    '|---|---|',
    ...(k.incidents.byType.length ? k.incidents.byType.map((t) => `| ${t.type} | ${t.n} |`) : ['| — | 0 |']),
    '',
    '| Zone | Incidents |',
    '|---|---|',
    ...(k.incidents.byZone.length ? k.incidents.byZone.map((z) => `| ${z.zone} | ${z.n} |`) : ['| — | 0 |']),
    '',
    '## Response times (from alert)',
    '| Stage | Median | 90th percentile | Measured |',
    '|---|---|---|---|',
    ...SLA_STAGES.map((s) => `| ${SLA_STAGE_LABEL[s]} | ${fmtMin(k.response[s].p50)} | ${fmtMin(k.response[s].p90)} | ${k.response[s].n} |`),
    '',
    '## SLA compliance',
    `- Overall: ${k.sla.compliancePct === null ? '—' : `${k.sla.compliancePct}%`} (${k.sla.met} met, ${k.sla.breached} breached of ${k.sla.measured} measured stages)`,
    ...SLA_STAGES.map((s) => `- ${SLA_STAGE_LABEL[s]}: ${k.sla.byStage[s].met} met, ${k.sla.byStage[s].breached} breached`),
    '',
    '## Missions',
    `- Total ${k.missions.total}: ${k.missions.completed} completed, ${k.missions.cancelled} cancelled, ${k.missions.failed} failed; ${k.missions.patrols} scheduled patrols`,
    ...(k.patrols ? [`- Patrol runs: ${k.patrols.runs}, skipped ${k.patrols.skipped}`] : []),
    '',
    ...(k.detections
      ? [
          '## AI / sensor detections',
          `- Total ${k.detections.total}: ${
            Object.entries(k.detections.byOutcome)
              .map(([o, n]) => `${o} ${n}`)
              .join(', ') || '—'
          }`,
          ...k.detections.byType.map((t) => `- ${t.type}: ${t.n}`),
          '',
        ]
      : []),
    '## Alerts by day',
    '| Day | Alerts |',
    '|---|---|',
    ...k.incidents.perDay.map((d) => `| ${d.day} | ${d.n} |`),
    '',
    'Times are measured from the alert to the first timeline entry of each stage. Stages without a limit in the playbook are not counted for compliance.',
  ];
  return lines.join('\n');
}
