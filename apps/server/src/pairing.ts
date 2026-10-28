// Edge pairing (CLEANUP_PLAN E-3). An administrator creates a one-time 6-digit code that carries the
// edge's configuration (gateway id, site, devices). The edge app sends the code to POST /api/v1/edge/pair
// and receives a fresh gateway key with its site configuration, so no person types, copies or sees the key.
//   - The code is stored hashed, works once and expires after PAIRING_CODE_TTL_MIN minutes.
//   - Wrong codes are throttled per address and in total, so guessing one code in a million stays hopeless.
//   - The configuration is erased from the database once the code is used, cancelled or expired.
//   - Pairing a gateway id again revokes the key its previous pairing issued.
import { randomInt } from 'node:crypto';
import { PAIRING_CODE_TTL_MIN, type ApiKeyView, type CreatePairingCode, type EdgePairRequest, type EdgePairResponse, type PairingCodeView } from '@13store/shared';
import { parseSiteConfig } from '@13store/gateway';
import type { Accounts } from './accounts';
import { tx, type DB } from './db';
import { ApiError, type Actor, type Platform } from './platform';
import { LoginThrottle, randomToken, sha256 } from './security';

const TTL_MS = PAIRING_CODE_TTL_MIN * 60_000;
/** Wrong codes from all addresses together before pairing pauses for one code lifetime. */
const MAX_WRONG_TOTAL = 30;
const MAX_WAITING_PER_ORG = 10;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

interface Row {
  id: string;
  org_id: string;
  site_id: string;
  label: string;
  gateway_id: string;
  device_ids: string;
  config: string | null;
  created_by: string;
  created_at: number;
  expires_at: number;
  cancelled: number;
  paired_at: number | null;
  paired_by: string | null;
  key_id: string | null;
}

const hashCode = (code: string) => sha256(`edge-pair:${code}`);

export class EdgePairing {
  /** 5 wrong codes from one address lock it out for a minute. */
  private perAddress = new LoginThrottle(5, 60_000);
  private wrongAt: number[] = [];
  private pausedUntil = 0;

  constructor(
    private db: DB,
    private p: Platform,
    private accounts: Accounts,
    private keyEnv: (orgId: string) => ApiKeyView['env'],
  ) {}

  private view(r: Row, now: number): PairingCodeView {
    const status = r.cancelled ? 'cancelled' : r.paired_at ? 'paired' : r.expires_at <= now ? 'expired' : 'waiting';
    return {
      id: r.id,
      label: r.label,
      gatewayId: r.gateway_id,
      siteId: r.site_id,
      deviceIds: JSON.parse(r.device_ids),
      createdAt: r.created_at,
      createdBy: r.created_by,
      expiresAt: r.expires_at,
      status,
      ...(r.paired_at ? { pairedAt: r.paired_at, pairedBy: r.paired_by ?? '' } : {}),
    };
  }

  /** Configurations (they may hold camera passwords) are kept only while their code can still be used. */
  private forgetExpired(now: number) {
    this.db.prepare('UPDATE pairing_codes SET config = NULL WHERE config IS NOT NULL AND expires_at <= ?').run(now);
  }

  list(a: Actor): PairingCodeView[] {
    this.p.require(a, 'admin.keys', 'pairing_codes', { mutating: false });
    const now = this.p.now();
    this.forgetExpired(now);
    const rows = this.db.prepare('SELECT * FROM pairing_codes WHERE org_id = ? ORDER BY created_at DESC LIMIT 20').all(a.orgId) as unknown as Row[];
    return rows.map((r) => this.view(r, now));
  }

  create(a: Actor, input: CreatePairingCode): PairingCodeView & { code: string } {
    this.p.require(a, 'admin.keys', 'pairing_codes');
    const now = this.p.now();
    const gatewayId = String(input?.gatewayId ?? '').trim();
    if (!GATEWAY_ID.test(gatewayId)) throw new ApiError(400, 'invalid', 'Gateway id: 3–64 letters, digits, dots, dashes or underscores, e.g. edge-unirc-01.');
    const site = this.p.site(a, input.siteId || undefined);
    const devices = input.devices;
    if (!Array.isArray(devices) || !devices.length) throw new ApiError(400, 'invalid', 'List at least one device for the edge to run.');
    try {
      parseSiteConfig({ geo: site.geometry.geo, devices });
    } catch (e) {
      throw new ApiError(400, 'invalid', `Device list: ${(e as Error).message}`);
    }
    const deviceIds = (devices as { deviceId?: string }[]).map((d) => d.deviceId).filter((x): x is string => !!x);
    const waiting = this.db
      .prepare('SELECT COUNT(*) AS n FROM pairing_codes WHERE org_id = ? AND cancelled = 0 AND paired_at IS NULL AND expires_at > ?')
      .get(a.orgId, now) as { n: number };
    if (waiting.n >= MAX_WAITING_PER_ORG) throw new ApiError(409, 'conflict', `${MAX_WAITING_PER_ORG} codes are already waiting. Cancel one or let them expire.`);

    // The code alone identifies the org on the public endpoint: it must not collide with any live code.
    const live = this.db.prepare('SELECT 1 FROM pairing_codes WHERE code_hash = ? AND cancelled = 0 AND paired_at IS NULL AND expires_at > ?');
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!live.get(hashCode(c), now)) code = c;
    }
    if (!code) throw new ApiError(503, 'error', 'Could not find a free code. Try again.');

    const id = `pair-${randomToken('', 6)}`;
    const label = (String(input.label ?? '').trim() || `Edge ${gatewayId}`).slice(0, 60);
    this.db
      .prepare(
        'INSERT INTO pairing_codes (id, org_id, site_id, code_hash, label, gateway_id, device_ids, config, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, a.orgId, site.id, hashCode(code), label, gatewayId, JSON.stringify(deviceIds), JSON.stringify({ devices }), a.name, now, now + TTL_MS);
    this.p.audit(a, 'edge.pairing_code', id, 'ok', `gateway ${gatewayId} · ${deviceIds.join(', ') || 'no device ids'} · valid ${PAIRING_CODE_TTL_MIN} min`);
    const row = this.db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id) as unknown as Row;
    return { ...this.view(row, now), code };
  }

  cancel(a: Actor, id: string) {
    this.p.require(a, 'admin.keys', id);
    const r = this.db
      .prepare('UPDATE pairing_codes SET cancelled = 1, config = NULL WHERE id = ? AND org_id = ? AND paired_at IS NULL AND cancelled = 0 AND expires_at > ?')
      .run(id, a.orgId, this.p.now());
    if (!r.changes) throw new ApiError(404, 'not_found', 'No waiting code with this id.');
    this.p.audit(a, 'edge.pairing_cancel', id);
  }

  /** Public: exchange a code for the gateway key and configuration. `serverUrl` is how the edge reached us. */
  pair(input: EdgePairRequest, from: { ip: string; serverUrl: string }): EdgePairResponse {
    const now = this.p.now();
    if (this.pausedUntil > now || this.perAddress.blocked(from.ip, now)) {
      throw new ApiError(429, 'rate_limited', 'Too many wrong codes. Wait a few minutes, then ask the administrator for a new code.');
    }
    const code = String(input?.code ?? '').replace(/[\s-]/g, '');
    const client = String(input?.client ?? '').replace(/[\r\n]/g, ' ').slice(0, 120);
    const row = /^\d{6}$/.test(code)
      ? (this.db
          .prepare('SELECT * FROM pairing_codes WHERE code_hash = ? AND cancelled = 0 AND paired_at IS NULL AND expires_at > ?')
          .get(hashCode(code), now) as unknown as Row | undefined)
      : undefined;
    if (!row?.config) {
      this.wrong(from.ip, now);
      throw new ApiError(400, 'invalid_code', 'This code is wrong, already used or expired. Ask the administrator for a new code.');
    }
    this.perAddress.ok(from.ip);

    const { devices } = JSON.parse(row.config) as { devices: unknown[] };
    const site = this.p.site(this.p.systemActor(row.org_id), row.site_id);
    const actor: Actor = { ...this.p.systemActor(row.org_id), name: `Edge pairing (code by ${row.created_by})` };
    const key = tx(this.db, () => {
      const claimed = this.db.prepare('UPDATE pairing_codes SET paired_at = ?, paired_by = ?, config = NULL WHERE id = ? AND paired_at IS NULL').run(now, client || from.ip, row.id);
      if (!claimed.changes) throw new ApiError(400, 'invalid_code', 'This code was just used.');
      const previous = this.db
        .prepare('SELECT key_id FROM pairing_codes WHERE org_id = ? AND gateway_id = ? AND key_id IS NOT NULL AND id != ?')
        .all(row.org_id, row.gateway_id, row.id) as { key_id: string }[];
      for (const { key_id } of previous) {
        const r = this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0').run(key_id);
        if (r.changes) this.p.audit(actor, 'admin.key_revoke', key_id, 'ok', `replaced: ${row.gateway_id} paired again`);
      }
      const k = this.accounts.createKey(actor, { label: `${row.label} (paired)`, kind: 'gateway', siteIds: [row.site_id] }, this.keyEnv(row.org_id));
      this.db.prepare('UPDATE pairing_codes SET key_id = ? WHERE id = ?').run(k.id, row.id);
      return k;
    });
    this.p.audit(actor, 'edge.paired', row.gateway_id, 'ok', `code ${row.id} · key ${key.id} · ${client || `from ${from.ip}`}`);
    return { gatewayId: row.gateway_id, key: key.secret, serverUrl: from.serverUrl, site: { id: site.id, name: site.name }, geo: site.geometry.geo!, devices };
  }

  private wrong(ip: string, now: number) {
    this.perAddress.fail(ip, now);
    this.wrongAt = this.wrongAt.filter((t) => t > now - TTL_MS);
    this.wrongAt.push(now);
    if (this.wrongAt.length >= MAX_WRONG_TOTAL) {
      this.pausedUntil = now + TTL_MS;
      this.wrongAt = [];
      console.warn(`[server] edge pairing paused for ${PAIRING_CODE_TTL_MIN} min: ${MAX_WRONG_TOTAL} wrong codes`);
    }
  }
}
