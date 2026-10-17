// Data retention (PDPA / customer policy) and data-subject requests.
// Retention is per organisation, set by an administrator and audited; the purge runs hourly.
// The audit log is never purged by this job: it is the record of what the platform did and is
// kept for the legal retention period and exported through backups.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ORG_SETTINGS,
  DEFAULT_PLAYBOOKS,
  NOTIFY_EVENTS,
  type Incident,
  type NotificationChannel,
  type NotifyEvent,
  type OrgSettings,
  type Playbook,
  type SlaStage,
} from '@13store/shared';
import type { DB } from './db';
import { defaultRules, validateRules } from './detections';

const DAY = 86_400_000;

export function getOrgSettings(db: DB, orgId: string): OrgSettings {
  const r = db.prepare('SELECT settings FROM orgs WHERE id = ?').get(orgId) as { settings: string } | undefined;
  let stored: Partial<OrgSettings> = {};
  try {
    stored = r ? (JSON.parse(r.settings || '{}') as Partial<OrgSettings>) : {};
  } catch {
    stored = {};
  }
  return {
    retention: { ...DEFAULT_ORG_SETTINGS.retention, ...(stored.retention ?? {}) },
    detection: {
      rules: Array.isArray(stored.detection?.rules) ? stored.detection!.rules : defaultRules(),
      timezone: stored.detection?.timezone || DEFAULT_ORG_SETTINGS.detection.timezone,
    },
    playbooks: Array.isArray(stored.playbooks) ? stored.playbooks : DEFAULT_PLAYBOOKS.map((b) => ({ ...b, steps: b.steps.map((x) => ({ ...x })), sla: { ...b.sla } })),
    notifications: { channels: Array.isArray(stored.notifications?.channels) ? stored.notifications!.channels : [] },
  };
}

/** Validates and stores a settings patch. Days: integers 0–3650 (0 = keep forever). */
export function setOrgSettings(db: DB, orgId: string, patch: Partial<OrgSettings>): OrgSettings {
  const cur = getOrgSettings(db, orgId);
  const next: OrgSettings = {
    retention: { ...cur.retention },
    detection: { rules: cur.detection.rules, timezone: cur.detection.timezone },
    playbooks: cur.playbooks,
    notifications: { channels: cur.notifications.channels },
  };
  for (const k of Object.keys(DEFAULT_ORG_SETTINGS.retention) as (keyof OrgSettings['retention'])[]) {
    const v = patch.retention?.[k];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0 || v > 3650) throw new Error(`${k} must be a whole number of days between 0 and 3650`);
    next.retention[k] = v;
  }
  if (patch.detection?.rules !== undefined) next.detection.rules = validateRules(patch.detection.rules);
  if (patch.detection?.timezone !== undefined) {
    const tz = String(patch.detection.timezone);
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    } catch {
      throw new Error(`Unknown time zone ${tz}`);
    }
    next.detection.timezone = tz;
  }
  if (patch.playbooks !== undefined) next.playbooks = validatePlaybooks(patch.playbooks);
  if (patch.notifications?.channels !== undefined) next.notifications.channels = validateChannels(patch.notifications.channels, cur.notifications.channels);
  db.prepare('UPDATE orgs SET settings = ? WHERE id = ?').run(JSON.stringify(next), orgId);
  return next;
}

/** Secrets never leave the server in clear: the console sees a mask and sends it back unchanged. */
export const SECRET_MASK = '••••••••';

export function maskChannels(channels: NotificationChannel[]): NotificationChannel[] {
  return channels.map((c) => ({
    ...c,
    webhook: c.webhook ? { ...c.webhook, secret: c.webhook.secret ? SECRET_MASK : undefined } : undefined,
    line: c.line ? { ...c.line, token: c.line.token ? SECRET_MASK : '' } : undefined,
    sms: c.sms ? { ...c.sms, headers: c.sms.headers ? Object.fromEntries(Object.keys(c.sms.headers).map((k) => [k, SECRET_MASK])) : undefined } : undefined,
  }));
}

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const HTTP_URL = /^https?:\/\//i;

function validateChannels(input: unknown, current: NotificationChannel[]): NotificationChannel[] {
  if (!Array.isArray(input)) throw new Error('notifications.channels must be a list.');
  if (input.length > 20) throw new Error('At most 20 notification channels.');
  const ids = new Set<string>();
  return input.map((raw, i) => {
    const c = raw as Record<string, any>;
    const where = `Channel ${i + 1}`;
    if (!c || typeof c !== 'object') throw new Error(`${where} must be an object.`);
    if (typeof c.id !== 'string' || !ID.test(c.id)) throw new Error(`${where}: id must be 1–32 letters, digits, - or _.`);
    if (ids.has(c.id)) throw new Error(`${where}: duplicate id ${c.id}.`);
    ids.add(c.id);
    const prev = current.find((x) => x.id === c.id);
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) throw new Error(`${where}: name is required (max 80 characters).`);
    if (!['webhook', 'line', 'sms'].includes(c.kind)) throw new Error(`${where}: kind must be webhook, line or sms.`);
    const events = Array.isArray(c.events) ? [...new Set(c.events.filter((e: unknown) => NOTIFY_EVENTS.includes(e as NotifyEvent)))] : [];
    if (!events.length) throw new Error(`${where}: pick at least one event.`);
    const unmask = (v: unknown, prevV: string | undefined) => (v === SECRET_MASK ? (prevV ?? '') : typeof v === 'string' ? v : '');
    const out: NotificationChannel = {
      id: c.id,
      name: c.name.trim(),
      kind: c.kind,
      enabled: c.enabled !== false,
      events: events as NotifyEvent[],
      minSeverity: ['low', 'medium', 'high'].includes(c.minSeverity) ? c.minSeverity : undefined,
    };
    if (c.kind === 'webhook') {
      const url = String(c.webhook?.url ?? '');
      if (!HTTP_URL.test(url) || url.length > 500) throw new Error(`${where}: webhook.url must be an http(s) URL.`);
      const secret = unmask(c.webhook?.secret, prev?.webhook?.secret);
      out.webhook = { url, secret: secret || undefined };
    } else if (c.kind === 'line') {
      const token = unmask(c.line?.token, prev?.line?.token);
      const to = String(c.line?.to ?? '').trim();
      if (!token || !to) throw new Error(`${where}: line.token and line.to are required.`);
      out.line = { token, to };
    } else {
      const url = String(c.sms?.url ?? '');
      if (!HTTP_URL.test(url) || url.length > 500) throw new Error(`${where}: sms.url must be an http(s) URL.`);
      const to = Array.isArray(c.sms?.to)
        ? c.sms.to
            .map(String)
            .map((x: string) => x.trim())
            .filter(Boolean)
        : [];
      if (!to.length || to.length > 50) throw new Error(`${where}: sms.to needs 1–50 numbers.`);
      const headers: Record<string, string> | undefined =
        c.sms?.headers && typeof c.sms.headers === 'object'
          ? Object.fromEntries(Object.entries(c.sms.headers as Record<string, unknown>).map(([k, v]) => [k, unmask(v, prev?.sms?.headers?.[k])]))
          : undefined;
      out.sms = { url, method: c.sms?.method === 'GET' ? 'GET' : 'POST', headers, body: typeof c.sms?.body === 'string' ? c.sms.body.slice(0, 2000) : undefined, to };
    }
    return out;
  });
}

function validatePlaybooks(input: unknown): Playbook[] {
  if (!Array.isArray(input)) throw new Error('playbooks must be a list.');
  if (input.length > 30) throw new Error('At most 30 playbooks.');
  const ids = new Set<string>();
  return input.map((raw, i) => {
    const b = raw as Record<string, any>;
    const where = `Playbook ${i + 1}`;
    if (!b || typeof b !== 'object') throw new Error(`${where} must be an object.`);
    if (typeof b.id !== 'string' || !ID.test(b.id)) throw new Error(`${where}: id must be 1–32 letters, digits, - or _.`);
    if (ids.has(b.id)) throw new Error(`${where}: duplicate id ${b.id}.`);
    ids.add(b.id);
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new Error(`${where}: name is required (max 80 characters).`);
    const m = (b.match ?? {}) as Record<string, unknown>;
    const steps = Array.isArray(b.steps) ? b.steps : [];
    if (steps.length > 30) throw new Error(`${where}: at most 30 steps.`);
    const sla = (b.sla ?? {}) as Record<string, unknown>;
    const lim = (k: SlaStage) => {
      const v = sla[k] ?? 0;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_080) throw new Error(`${where}: sla.${k} must be minutes between 0 and 10080.`);
      return v;
    };
    return {
      id: b.id,
      name: b.name.trim(),
      match: {
        types: Array.isArray(m.types)
          ? (m.types as unknown[])
              .map(String)
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 20)
          : undefined,
        severities: Array.isArray(m.severities)
          ? ((m.severities as unknown[]).filter((x) => ['low', 'medium', 'high'].includes(x as string)) as Playbook['match']['severities'])
          : undefined,
        sourceContains: typeof m.sourceContains === 'string' && m.sourceContains.trim() ? m.sourceContains.trim().slice(0, 60) : undefined,
      },
      steps: steps.map((st: Record<string, unknown>, j: number) => {
        if (!st || typeof st.title !== 'string' || !st.title.trim()) throw new Error(`${where}: step ${j + 1} needs a title.`);
        return {
          id: typeof st.id === 'string' && ID.test(st.id) ? st.id : `s${j + 1}`,
          title: st.title.trim().slice(0, 160),
          detail: typeof st.detail === 'string' ? st.detail.trim().slice(0, 300) || undefined : undefined,
          role: ['dispatcher', 'supervisor', 'operator', 'responder', 'auditor', 'admin'].includes(st.role as string) ? (st.role as Playbook['steps'][number]['role']) : undefined,
        };
      }),
      sla: { acknowledge: lim('acknowledge'), verify: lim('verify'), respond: lim('respond'), resolve: lim('resolve') },
    };
  });
}

export interface PurgeReport {
  telemetry: number;
  incidents: number;
  evidence: number;
  detections: number;
}

/** Deletes what the organisation's retention policy says has expired. Returns what was removed. */
export function purgeExpired(db: DB, orgId: string, dataDir: string, now: number, settings = getOrgSettings(db, orgId)): PurgeReport {
  const r = settings.retention;
  const report: PurgeReport = { telemetry: 0, incidents: 0, evidence: 0, detections: 0 };
  if (r.telemetryDays > 0) {
    const ids = (db.prepare('SELECT id FROM devices WHERE org_id = ?').all(orgId) as { id: string }[]).map((d) => d.id);
    for (const id of ids) report.telemetry += Number(db.prepare('DELETE FROM telemetry WHERE device_id = ? AND received_time < ?').run(id, now - r.telemetryDays * DAY).changes);
  }
  if (r.closedIncidentDays > 0) {
    const rows = db.prepare("SELECT id, data FROM incidents WHERE org_id = ? AND status = 'closed'").all(orgId) as { id: string; data: string }[];
    for (const row of rows) {
      const inc = JSON.parse(row.data) as Incident & { closedAt?: number };
      const closedAt = inc.closedAt ?? lastEventAt(db, orgId, inc.id) ?? inc.createdAt;
      if (closedAt > now - r.closedIncidentDays * DAY) continue;
      report.evidence += deleteEvidence(db, orgId, dataDir, 'incident_id = ?', [inc.id]);
      db.prepare('DELETE FROM timeline WHERE org_id = ? AND incident_id = ?').run(orgId, inc.id);
      db.prepare('DELETE FROM commands WHERE org_id = ? AND mission_id IN (SELECT id FROM missions WHERE incident_id = ?)').run(orgId, inc.id);
      db.prepare('DELETE FROM missions WHERE org_id = ? AND incident_id = ?').run(orgId, inc.id);
      db.prepare('DELETE FROM assignments WHERE org_id = ? AND incident_id = ?').run(orgId, inc.id);
      db.prepare('DELETE FROM detections WHERE org_id = ? AND incident_id = ?').run(orgId, inc.id);
      db.prepare('DELETE FROM incidents WHERE id = ?').run(inc.id);
      report.incidents++;
    }
  }
  if (r.evidenceDays > 0) report.evidence += deleteEvidence(db, orgId, dataDir, "json_extract(data, '$.capturedAt') < ?", [now - r.evidenceDays * DAY]);
  // Detections that raised an incident live and die with it; the rest expire on their own clock.
  if (r.detectionDays > 0)
    report.detections += Number(
      db.prepare("DELETE FROM detections WHERE org_id = ? AND at < ? AND outcome IN ('logged', 'ignored', 'duplicate')").run(orgId, now - r.detectionDays * DAY).changes,
    );
  return report;
}

function lastEventAt(db: DB, orgId: string, incidentId: string) {
  const r = db.prepare('SELECT MAX(at) AS at FROM timeline WHERE org_id = ? AND incident_id = ?').get(orgId, incidentId) as { at: number | null };
  return r.at ?? undefined;
}

function deleteEvidence(db: DB, orgId: string, dataDir: string, where: string, params: unknown[]) {
  const rows = db.prepare(`SELECT id, path FROM evidence WHERE org_id = ? AND ${where}`).all(orgId, ...(params as string[])) as { id: string; path: string | null }[];
  for (const e of rows) {
    if (e.path) {
      const p = join(dataDir, e.path);
      if (existsSync(p)) rmSync(p, { force: true });
    }
    db.prepare('DELETE FROM evidence WHERE id = ?').run(e.id);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// data-subject requests: find and redact a person's name in free text
// ---------------------------------------------------------------------------

export interface PrivacyMatch {
  table: 'incidents' | 'timeline' | 'evidence' | 'assignments';
  id: string;
  /** The incident the row belongs to (the row itself for incidents). */
  incidentId: string;
  field: string;
  excerpt: string;
}

const TEXT_FIELDS: Record<PrivacyMatch['table'], string[]> = {
  incidents: ['title', 'place', 'outcome', 'owner', 'source'],
  timeline: ['title', 'detail', 'actor'],
  evidence: ['note', 'filename', 'by'],
  assignments: ['note', 'responderName', 'report'],
};

function scan(db: DB, orgId: string, q: string, fn: (t: PrivacyMatch['table'], id: string, incidentId: string, data: Record<string, unknown>, hit: string[]) => void) {
  const needle = q.toLowerCase();
  for (const table of Object.keys(TEXT_FIELDS) as PrivacyMatch['table'][]) {
    const rows = db.prepare(`SELECT id, ${table === 'incidents' ? 'id' : 'incident_id'} AS incident_id, data FROM ${table} WHERE org_id = ?`).all(orgId) as {
      id: string;
      incident_id: string;
      data: string;
    }[];
    for (const r of rows) {
      const data = JSON.parse(r.data) as Record<string, unknown>;
      const hit = TEXT_FIELDS[table].filter((f) => typeof data[f] === 'string' && (data[f] as string).toLowerCase().includes(needle));
      if (hit.length) fn(table, r.id, r.incident_id, data, hit);
    }
  }
}

/** Where a name (or any text) appears in incident data, timeline, evidence notes and assignments. */
export function privacyExport(db: DB, orgId: string, q: string): PrivacyMatch[] {
  if (q.trim().length < 3) throw new Error('Search text must be at least 3 characters.');
  const out: PrivacyMatch[] = [];
  scan(db, orgId, q.trim(), (table, id, incidentId, data, hit) => {
    for (const f of hit) {
      const text = data[f] as string;
      const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
      out.push({ table, id: String(data.id ?? id), incidentId, field: f, excerpt: text.slice(Math.max(0, i - 40), i + q.length + 40) });
    }
  });
  return out;
}

/** Replaces the text everywhere it was found. Returns the number of fields changed. */
export function privacyErase(db: DB, orgId: string, q: string, replacement = '[erased]'): { changed: number; ids: string[] } {
  if (q.trim().length < 3) throw new Error('Search text must be at least 3 characters.');
  const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let changed = 0;
  const ids: string[] = [];
  scan(db, orgId, q.trim(), (table, id, _incidentId, data, hit) => {
    for (const f of hit) {
      data[f] = (data[f] as string).replace(re, replacement);
      changed++;
    }
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(data), id);
    ids.push(String(data.id ?? id));
  });
  return { changed, ids: [...new Set(ids)] };
}
