// First-run data. Demo env gets the booth scenario with fixed, documented demo credentials.
// Pilot env gets an empty org, one admin, and random keys printed once.
import { SEED_USERS, SITE, SITE_GEOMETRY, seedDevices, seedEvidence, seedIncidents, seedTimeline, type Device } from '@13store/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import { tx, type DB } from './db';
import { hashPassword, randomToken, sha256 } from './security';

export const DEMO_ORG = 'org-demo';
export const DEMO_SITE = 'site-civic';
export const SANDBOX_ORG = 'org-sandbox';
export const SANDBOX_SITE = 'site-sandbox';
/** Fixed keys for the demo environment only (documented in the README). */
export const DEMO_GATEWAY_KEY = 'gw_demo_local_key';
export const DEMO_ALERT_KEY = 'sk_demo_alerts_local';
export const SANDBOX_KEY = 'sk_sandbox_demo_key';
export const SANDBOX_GATEWAY_KEY = 'gw_sandbox_demo_key';

const USERNAMES: Record<string, string> = {
  'u-alex': 'alex',
  'u-nida': 'nida',
  'u-somchai': 'somchai',
  'u-kitti': 'kitti',
  'u-priya': 'priya',
  'u-ploy': 'ploy',
};

/** Frame stored with the seeded evidence so checksums cover real bytes. */
const SEED_FRAME = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#101b2b"/><rect x="120" y="110" width="96" height="6" fill="#e8edf2"/><text x="10" y="20" fill="#fbbf24" font-family="sans-serif" font-size="12">CCTV-02 · SIMULATED</text></svg>`;

function key(db: DB, orgId: string, label: string, kind: string, env: string, secret: string, now: number) {
  db.prepare('INSERT INTO api_keys (id, org_id, label, kind, env, prefix, key_hash, site_ids, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
    `key-${sha256(secret).slice(0, 8)}`,
    orgId,
    label,
    kind,
    env,
    secret.slice(0, 12),
    sha256(secret),
    '[]',
    now,
  );
}

export function isSeeded(db: DB) {
  return !!db.prepare('SELECT 1 FROM orgs LIMIT 1').get();
}

export function seed(db: DB, cfg: Config, now = Date.now()) {
  if (isSeeded(db)) return { created: false as const };
  const printed: string[] = [];
  tx(db, () => {
    db.prepare('INSERT INTO orgs (id, name, id_prefix, env) VALUES (?,?,?,?)').run(DEMO_ORG, cfg.env === 'demo' ? '13STORE Demo Org' : 'Pilot Organisation', '', cfg.env);
    db.prepare('INSERT INTO sites (id, org_id, name, crs, geometry) VALUES (?,?,?,?,?)').run(DEMO_SITE, DEMO_ORG, SITE.name, SITE.crs, JSON.stringify(SITE_GEOMETRY));

    if (cfg.env === 'pilot') {
      const pw = process.env.ADMIN_PASSWORD || randomToken('', 12);
      db.prepare('INSERT INTO users (id, org_id, username, name, title, role, pw_hash, site_ids, active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)').run(
        'u-admin',
        DEMO_ORG,
        'admin',
        'Administrator',
        'Administrator',
        'admin',
        hashPassword(pw),
        '[]',
        now,
      );
      const gw = randomToken('gw_pilot_');
      key(db, DEMO_ORG, 'Edge gateway', 'gateway', 'pilot', gw, now);
      if (!process.env.ADMIN_PASSWORD) printed.push(`admin password: ${pw}`);
      printed.push(`gateway key: ${gw}`);
      return;
    }

    for (const u of SEED_USERS) {
      db.prepare('INSERT INTO users (id, org_id, username, name, title, role, pw_hash, site_ids, active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)').run(
        u.id,
        DEMO_ORG,
        USERNAMES[u.id] ?? u.id,
        u.name,
        u.title,
        u.role,
        hashPassword(cfg.seedPassword),
        '[]',
        now,
      );
    }
    seedOperational(db, cfg, now);
    key(db, DEMO_ORG, 'Demo edge gateway', 'gateway', 'demo', DEMO_GATEWAY_KEY, now);
    key(db, DEMO_ORG, 'Demo alert source', 'integration', 'demo', DEMO_ALERT_KEY, now);

    // Developer sandbox: separate org, separate credentials (F16).
    db.prepare('INSERT INTO orgs (id, name, id_prefix, env) VALUES (?,?,?,?)').run(SANDBOX_ORG, '13STORE Developer Sandbox', 'SBX-', 'sandbox');
    db.prepare('INSERT INTO sites (id, org_id, name, crs, geometry) VALUES (?,?,?,?,?)').run(SANDBOX_SITE, SANDBOX_ORG, 'Sandbox Yard', SITE.crs, JSON.stringify({ ...SITE_GEOMETRY, name: 'Sandbox Yard' }));
    db.prepare('INSERT INTO users (id, org_id, username, name, title, role, pw_hash, site_ids, active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)').run(
      'u-dev',
      SANDBOX_ORG,
      'dev',
      'Sandbox Developer',
      'Developer (sandbox)',
      'dispatcher',
      hashPassword(cfg.seedPassword),
      '[]',
      now,
    );
    db.prepare('INSERT INTO users (id, org_id, username, name, title, role, pw_hash, site_ids, active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)').run(
      'u-devop',
      SANDBOX_ORG,
      'devop',
      'Sandbox Operator',
      'Operator (sandbox)',
      'operator',
      hashPassword(cfg.seedPassword),
      '[]',
      now,
    );
    const rover: Device = {
      id: 'SBX-ROVER-01',
      kind: 'ugv',
      model: 'Your rover (BUILD YOUR OWN)',
      adapterVersion: '—',
      firmwareTested: 'not tested',
      integration: 'testing',
      capabilities: [],
      commands: [],
      limitations: 'Waiting for an adapter to connect.',
      zone: 'Zone A',
      pos: { x: 120, y: 220 },
      accuracyM: 2,
      lastSeen: 0,
      rateMs: 1000,
      speed: 0,
    };
    db.prepare('INSERT INTO devices (id, org_id, site_id, data, registered_at) VALUES (?,?,?,?,?)').run(rover.id, SANDBOX_ORG, SANDBOX_SITE, JSON.stringify(rover), now);
    key(db, SANDBOX_ORG, 'Sandbox integration', 'integration', 'sandbox', SANDBOX_KEY, now);
    key(db, SANDBOX_ORG, 'Sandbox gateway', 'gateway', 'sandbox', SANDBOX_GATEWAY_KEY, now);
  });
  return { created: true as const, printed };
}

/** Incidents, devices, timeline and evidence for the booth scenario (also used by demo reset). */
export function seedOperational(db: DB, cfg: Config, now: number) {
  const devs = seedDevices(now);
  for (const d of Object.values(devs)) {
    db.prepare('INSERT INTO devices (id, org_id, site_id, data, registered_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, gateway_id = NULL').run(
      d.id,
      DEMO_ORG,
      DEMO_SITE,
      JSON.stringify({ ...d, controlOwner: undefined }),
      now,
    );
  }
  for (const inc of seedIncidents(now)) {
    db.prepare('INSERT INTO incidents (id, org_id, site_id, status, created_at, data) VALUES (?,?,?,?,?,?)').run(inc.id, DEMO_ORG, DEMO_SITE, inc.status, inc.createdAt, JSON.stringify(inc));
  }
  db.prepare("INSERT INTO counters (org_id, name, value) VALUES (?, 'incident', 24) ON CONFLICT(org_id, name) DO UPDATE SET value = 24").run(DEMO_ORG);
  for (const e of seedTimeline(now)) {
    db.prepare('INSERT INTO timeline (id, org_id, incident_id, at, received_at, data) VALUES (?,?,?,?,?,?)').run(`${DEMO_ORG}:${e.id}`, DEMO_ORG, e.incidentId, e.at, e.receivedAt, JSON.stringify(e));
  }
  // INC-023 is with Field team 2 (Kittipong), already accepted.
  db.prepare('INSERT INTO assignments (id, org_id, incident_id, responder_id, status, data) VALUES (?,?,?,?,?,?)').run(
    'ASG-1',
    DEMO_ORG,
    'INC-023',
    'u-kitti',
    'accepted',
    JSON.stringify({ id: 'ASG-1', incidentId: 'INC-023', responderId: 'u-kitti', status: 'accepted', createdAt: now - 7 * 60_000, updatedAt: now - 6 * 60_000 }),
  );
  db.prepare("INSERT INTO counters (org_id, name, value) VALUES (?, 'asg', 1) ON CONFLICT(org_id, name) DO UPDATE SET value = 1").run(DEMO_ORG);
  const dir = join(cfg.dataDir, 'evidence', DEMO_ORG);
  mkdirSync(dir, { recursive: true });
  for (const ev of seedEvidence(now)) {
    const path = join('evidence', DEMO_ORG, `${ev.id}.svg`);
    writeFileSync(join(dir, `${ev.id}.svg`), SEED_FRAME);
    const full = { ...ev, checksum: sha256(SEED_FRAME), mime: 'image/svg+xml', size: SEED_FRAME.length, retentionClass: 'standard', receivedAt: ev.capturedAt + 400 };
    db.prepare('INSERT INTO evidence (id, org_id, incident_id, sha256, path, idempotency_key, data) VALUES (?,?,?,?,?,?,?)').run(ev.id, DEMO_ORG, ev.incidentId, full.checksum, path, null, JSON.stringify(full));
  }
}

/** Demo reset: clear operational data (never the audit log) and reseed the booth scenario. */
export function resetDemo(db: DB, cfg: Config, now = Date.now()) {
  tx(db, () => {
    for (const t of ['incidents', 'missions', 'commands', 'timeline', 'evidence', 'assignments', 'idempotency']) db.prepare(`DELETE FROM ${t} WHERE org_id = ?`).run(DEMO_ORG);
    db.prepare("DELETE FROM telemetry WHERE device_id IN (SELECT id FROM devices WHERE org_id = ?)").run(DEMO_ORG);
    db.prepare("DELETE FROM counters WHERE org_id = ? AND name != 'evt'").run(DEMO_ORG);
    seedOperational(db, cfg, now);
  });
}
