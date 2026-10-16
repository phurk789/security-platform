import type { CommandStatus, Freshness, IncidentStatus, IntegrationStatus, MissionStatus } from '../domain/types';

type Tone = 'cyan' | 'amber' | 'red' | 'green' | 'grey' | 'violet';

export function Badge({ tone, children, title, solid }: { tone: Tone; children: React.ReactNode; title?: string; solid?: boolean }) {
  return (
    <span className={`badge badge-${tone}${solid ? ' solid' : ''}`} title={title}>
      {children}
    </span>
  );
}

export const INCIDENT_LABEL: Record<IncidentStatus, [string, Tone]> = {
  new: ['New · awaiting verification', 'amber'],
  triaging: ['Triaging', 'amber'],
  confirmed: ['Confirmed', 'cyan'],
  responding: ['Responding', 'cyan'],
  resolved: ['Resolved', 'green'],
  closed: ['Closed', 'grey'],
  duplicate: ['Duplicate', 'grey'],
  dismissed: ['Dismissed', 'grey'],
};

export function IncidentBadge({ status }: { status: IncidentStatus }) {
  const [l, t] = INCIDENT_LABEL[status];
  return <Badge tone={t}>{l}</Badge>;
}

export const MISSION_LABEL: Record<MissionStatus, [string, Tone]> = {
  draft: ['Draft', 'grey'],
  pending_approval: ['Pending approval', 'amber'],
  approved: ['Approved', 'cyan'],
  assigned: ['Assigned · operator ready', 'cyan'],
  executing: ['Executing', 'green'],
  paused: ['Paused', 'amber'],
  completed: ['Completed', 'green'],
  rejected: ['Rejected', 'red'],
  cancelled: ['Cancelled', 'grey'],
  failed: ['Failed', 'red'],
};

export function MissionBadge({ status }: { status: MissionStatus }) {
  const [l, t] = MISSION_LABEL[status];
  return <Badge tone={t}>{l}</Badge>;
}

export const COMMAND_LABEL: Record<CommandStatus, [string, Tone]> = {
  requested: ['Requested', 'grey'],
  authorized: ['Authorized', 'grey'],
  sent: ['Sent · waiting for device', 'amber'],
  acknowledged: ['Acknowledged', 'cyan'],
  executing: ['Executing · waiting for confirmation', 'cyan'],
  succeeded: ['Confirmed by device', 'green'],
  rejected: ['Rejected', 'red'],
  failed: ['Failed', 'red'],
  timed_out: ['Timed out · result unknown', 'red'],
  unknown: ['Unknown result', 'red'],
};

export function CommandBadge({ status }: { status: CommandStatus }) {
  const [l, t] = COMMAND_LABEL[status];
  return <Badge tone={t}>{l}</Badge>;
}

export function FreshBadge({ f, age }: { f: Freshness; age?: string }) {
  if (f === 'live') return <Badge tone="green">LIVE{age ? ` · ${age}` : ''}</Badge>;
  if (f === 'stale') return <Badge tone="amber" solid>STALE{age ? ` · ${age}` : ''}</Badge>;
  return <Badge tone="red" solid>OFFLINE{age ? ` · last seen ${age}` : ''}</Badge>;
}

export function IntegrationBadge({ i }: { i: IntegrationStatus }) {
  if (i === 'verified') return <Badge tone="green">VERIFIED</Badge>;
  if (i === 'testing') return <Badge tone="amber">TESTING</Badge>;
  return <Badge tone="violet" solid title="Simulated adapter — not a real integration">SIMULATED</Badge>;
}
