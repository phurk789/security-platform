// SQLite storage (node:sqlite, no native build step). One file per deployment.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, id_prefix TEXT NOT NULL DEFAULT '', env TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
  crs TEXT NOT NULL, geometry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL, pw_hash TEXT NOT NULL,
  site_ids TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, step_up_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), label TEXT NOT NULL, kind TEXT NOT NULL,
  env TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, site_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS counters (org_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (org_id, name));
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), site_id TEXT NOT NULL REFERENCES sites(id),
  data TEXT NOT NULL, gateway_id TEXT, registered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS telemetry (
  device_id TEXT NOT NULL, seq INTEGER NOT NULL, source_time INTEGER NOT NULL, received_time INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, alt REAL, accuracy REAL, battery REAL, speed REAL, quality TEXT
);
CREATE INDEX IF NOT EXISTS telemetry_device_time ON telemetry(device_id, received_time);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_org ON incidents(org_id, site_id, created_at);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, incident_id TEXT NOT NULL,
  device_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, mission_id TEXT NOT NULL,
  device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, incident_id TEXT NOT NULL, at INTEGER NOT NULL,
  received_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS timeline_incident ON timeline(incident_id, at);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, incident_id TEXT NOT NULL, sha256 TEXT, path TEXT,
  idempotency_key TEXT, data TEXT NOT NULL, UNIQUE (org_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, incident_id TEXT NOT NULL, responder_id TEXT NOT NULL,
  status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  org_id TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (org_id, key)
);
CREATE TABLE IF NOT EXISTS audit (
  org_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, actor_id TEXT, actor TEXT NOT NULL,
  role TEXT NOT NULL, action TEXT NOT NULL, object TEXT NOT NULL, result TEXT NOT NULL, detail TEXT,
  request_id TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (org_id, seq)
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Next number for a per-org counter (incident numbers, mission numbers...). */
export function nextNumber(db: DB, orgId: string, name: string, start = 1): number {
  const row = db.prepare('SELECT value FROM counters WHERE org_id = ? AND name = ?').get(orgId, name) as { value: number } | undefined;
  const value = row ? row.value + 1 : start;
  db.prepare('INSERT INTO counters (org_id, name, value) VALUES (?, ?, ?) ON CONFLICT(org_id, name) DO UPDATE SET value = excluded.value').run(orgId, name, value);
  return value;
}
