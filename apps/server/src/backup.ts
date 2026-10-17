// Backup and restore (PRD §8, §11: restore must be tested before the pilot).
// A backup = consistent SQLite copy (VACUUM INTO) + evidence files + a manifest of checksums.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyAudit } from './audit';
import type { DB } from './db';
import { sha256 } from './security';

export interface Manifest {
  id: string;
  createdAt: number;
  createdBy: string;
  files: { path: string; sha256: string; size: number }[];
  counts: Record<string, number>;
  auditHeads: Record<string, string | undefined>;
}

const TABLES = [
  'incidents',
  'missions',
  'commands',
  'timeline',
  'evidence',
  'assignments',
  'audit',
  'users',
  'devices',
  'detections',
  'geofences',
  'patrols',
  'device_stats',
  'notifications',
  'push_subscriptions',
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function counts(db: DatabaseSync | DB) {
  return Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
}

function heads(db: DB) {
  const orgs = db.prepare('SELECT id FROM orgs').all() as { id: string }[];
  return Object.fromEntries(orgs.map((o) => [o.id, verifyAudit(db, o.id).head]));
}

export function createBackup(db: DB, dataDir: string, createdBy: string, now = Date.now()): Manifest {
  const id = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dir = join(dataDir, 'backups', id);
  mkdirSync(dir, { recursive: true });
  const dbOut = join(dir, 'platform.sqlite');
  db.prepare('VACUUM INTO ?').run(dbOut);
  const evSrc = join(dataDir, 'evidence');
  if (existsSync(evSrc)) cpSync(evSrc, join(dir, 'evidence'), { recursive: true });
  const files = walk(dir).map((p) => ({ path: relative(dir, p), sha256: sha256(readFileSync(p)), size: statSync(p).size }));
  const manifest: Manifest = { id, createdAt: now, createdBy, files, counts: counts(db), auditHeads: heads(db) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function listBackups(dataDir: string): Manifest[] {
  const root = join(dataDir, 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, 'manifest.json')))
    .map((d) => JSON.parse(readFileSync(join(root, d, 'manifest.json'), 'utf8')) as Manifest)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Checks every file against the manifest and that the backed-up audit chains still verify. */
export function verifyBackup(dataDir: string, id: string) {
  if (!/^[0-9TZ-]+$/.test(id)) return { ok: false, problems: ['invalid backup id'] };
  const dir = join(dataDir, 'backups', id);
  const problems: string[] = [];
  if (!existsSync(join(dir, 'manifest.json'))) return { ok: false, problems: ['manifest missing'] };
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  for (const f of m.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) problems.push(`missing ${f.path}`);
    else if (sha256(readFileSync(p)) !== f.sha256) problems.push(`checksum mismatch ${f.path}`);
  }
  if (!problems.length) {
    const copy = new DatabaseSync(join(dir, 'platform.sqlite'), { readOnly: true });
    const c = counts(copy);
    for (const t of TABLES) if (c[t] !== m.counts[t]) problems.push(`${t}: ${c[t]} rows, manifest says ${m.counts[t]}`);
    for (const org of Object.keys(m.auditHeads)) {
      const v = verifyAudit(copy as unknown as DB, org);
      if (!v.ok || v.head !== m.auditHeads[org]) problems.push(`audit chain for ${org} does not verify`);
    }
    copy.close();
  }
  return { ok: problems.length === 0, problems, manifest: m };
}

/** Restores into `targetDir` (server must be stopped). Verifies first. */
export function restoreBackup(dataDir: string, id: string, targetDir = dataDir) {
  const v = verifyBackup(dataDir, id);
  if (!v.ok) throw new Error(`Backup ${id} failed verification: ${v.problems.join('; ')}`);
  const dir = join(dataDir, 'backups', id);
  mkdirSync(targetDir, { recursive: true });
  for (const f of ['platform.sqlite-wal', 'platform.sqlite-shm']) rmSync(join(targetDir, f), { force: true });
  copyFileSync(join(dir, 'platform.sqlite'), join(targetDir, 'platform.sqlite'));
  rmSync(join(targetDir, 'evidence'), { recursive: true, force: true });
  if (existsSync(join(dir, 'evidence'))) cpSync(join(dir, 'evidence'), join(targetDir, 'evidence'), { recursive: true });
  return v.manifest!;
}

/** Keeps the newest `keep` backups and removes the rest. Returns the ids removed. */
export function pruneBackups(dataDir: string, keep: number) {
  const all = listBackups(dataDir);
  const drop = all.slice(Math.max(0, keep));
  for (const m of drop) rmSync(join(dataDir, 'backups', m.id), { recursive: true, force: true });
  return drop.map((m) => m.id);
}
