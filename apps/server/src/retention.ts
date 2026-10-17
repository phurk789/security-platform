// Data retention (PDPA / customer policy) and data-subject requests.
// Retention is per organisation, set by an administrator and audited; the purge runs hourly.
// The audit log is never purged by this job: it is the record of what the platform did and is
// kept for the legal retention period and exported through backups.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ORG_SETTINGS, type Incident, type OrgSettings } from '@13store/shared';
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
  };
}

/** Validates and stores a settings patch. Days: integers 0–3650 (0 = keep forever). */
export function setOrgSettings(db: DB, orgId: string, patch: Partial<OrgSettings>): OrgSettings {
  const cur = getOrgSettings(db, orgId);
  const next: OrgSettings = { retention: { ...cur.retention }, detection: { rules: cur.detection.rules, timezone: cur.detection.timezone } };
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
  db.prepare('UPDATE orgs SET settings = ? WHERE id = ?').run(JSON.stringify(next), orgId);
  return next;
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
