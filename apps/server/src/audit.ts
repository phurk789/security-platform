// Append-only audit log with a per-org hash chain, so edits or deletions are detectable (PRD §8).
import type { AuditEvent, Role } from '@13store/shared';
import type { DB } from './db';
import { sha256 } from './security';

export interface AuditInput {
  orgId: string;
  actorId?: string;
  actor: string;
  role: Role | 'integration' | 'gateway' | 'system';
  action: string;
  object: string;
  result: 'ok' | 'denied' | 'error';
  detail?: string;
  requestId?: string;
  at: number;
}

const GENESIS = '0'.repeat(64);

function digest(prev: string, e: { seq: number; at: number; actor: string; role: string; action: string; object: string; result: string; detail?: string | null; requestId?: string | null }) {
  return sha256(prev + JSON.stringify([e.seq, e.at, e.actor, e.role, e.action, e.object, e.result, e.detail ?? null, e.requestId ?? null]));
}

export function appendAudit(db: DB, a: AuditInput): AuditEvent & { seq: number } {
  const last = db.prepare('SELECT seq, hash FROM audit WHERE org_id = ? ORDER BY seq DESC LIMIT 1').get(a.orgId) as { seq: number; hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.hash ?? GENESIS;
  const id = `AUD-${String(seq).padStart(6, '0')}`;
  const hash = digest(prev, { seq, ...a });
  db.prepare(
    'INSERT INTO audit (org_id, seq, id, at, actor_id, actor, role, action, object, result, detail, request_id, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(a.orgId, seq, id, a.at, a.actorId ?? null, a.actor, a.role, a.action, a.object, a.result, a.detail ?? null, a.requestId ?? null, prev, hash);
  return { id, seq, at: a.at, actor: a.actor, role: a.role as Role, action: a.action, object: a.object, result: a.result, detail: a.detail };
}

interface Row {
  seq: number;
  id: string;
  at: number;
  actor: string;
  role: string;
  action: string;
  object: string;
  result: 'ok' | 'denied' | 'error';
  detail: string | null;
  request_id: string | null;
  prev_hash: string;
  hash: string;
}

export function listAudit(db: DB, orgId: string, opts: { limit?: number; before?: number } = {}): AuditEvent[] {
  const rows = db
    .prepare('SELECT * FROM audit WHERE org_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(orgId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 200) as unknown as Row[];
  return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, role: r.role as Role, action: r.action, object: r.object, result: r.result, detail: r.detail ?? undefined }));
}

/** Recompute the chain. Returns the first broken sequence number, if any. */
export function verifyAudit(db: DB, orgId: string): { ok: boolean; count: number; brokenAt?: number; head?: string } {
  const rows = db.prepare('SELECT * FROM audit WHERE org_id = ? ORDER BY seq ASC').all(orgId) as unknown as Row[];
  let prev = GENESIS;
  let expectSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectSeq || r.prev_hash !== prev) return { ok: false, count: rows.length, brokenAt: r.seq };
    const h = digest(prev, { seq: r.seq, at: r.at, actor: r.actor, role: r.role, action: r.action, object: r.object, result: r.result, detail: r.detail, requestId: r.request_id });
    if (h !== r.hash) return { ok: false, count: rows.length, brokenAt: r.seq };
    prev = r.hash;
    expectSeq += 1;
  }
  return { ok: true, count: rows.length, head: prev };
}
