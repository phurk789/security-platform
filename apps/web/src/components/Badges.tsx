import { useT } from '../i18n';
import { MODE_LABEL, modeOf, type CommandStatus, type Device, type Freshness, type IncidentStatus, type IntegrationStatus, type MissionStatus } from '@13store/shared';

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
  const tr = useT();
  const [l, t] = INCIDENT_LABEL[status];
  return <Badge tone={t}>{tr(l)}</Badge>;
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
  const tr = useT();
  const [l, t] = MISSION_LABEL[status];
  return <Badge tone={t}>{tr(l)}</Badge>;
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
  const tr = useT();
  const [l, t] = COMMAND_LABEL[status];
  return <Badge tone={t}>{tr(l)}</Badge>;
}

export function FreshBadge({ f, age }: { f: Freshness; age?: string }) {
  const t = useT();
  if (f === 'live') return <Badge tone="green" title={t('Data is fresh')}>LIVE{age ? ` · ${age}` : ''}</Badge>;
  if (f === 'stale') return <Badge tone="amber" solid title={t('Data is late. New commands are held.')}>STALE{age ? ` · ${age}` : ''}</Badge>;
  return <Badge tone="red" solid title={t('No data from this device')}>OFFLINE{age ? ` · ${t('last seen {age}', { age })}` : ''}</Badge>;
}

export function IntegrationBadge({ i }: { i: IntegrationStatus }) {
  const t = useT();
  if (i === 'verified') return <Badge tone="green" title={t('Integration tested and verified')}>VERIFIED</Badge>;
  if (i === 'testing') return <Badge tone="amber" title={t('Integration still being tested')}>TESTING</Badge>;
  return <Badge tone="violet" solid title={t('Simulated adapter — not a real integration')}>SIMULATED</Badge>;
}

/** Operational mode (ADR-006). Simulated devices already carry the SIMULATED badge, so they show none. */
export function ModeBadge({ d }: { d: Pick<Device, 'integration' | 'mode'> }) {
  const t = useT();
  const m = modeOf(d);
  if (m === 'SIMULATION') return null;
  const tone: Tone = m === 'SHADOW' ? 'grey' : m === 'LIVE_MANUAL' ? 'red' : 'amber';
  return (
    <Badge tone={tone} solid={m !== 'SHADOW'} title={t(MODE_LABEL[m])}>
      {m.replace('_', ' ')}
    </Badge>
  );
}
