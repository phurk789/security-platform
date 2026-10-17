// Licensing: a signed JSON file names the customer, what they may run (sites, devices, users) and
// until when. Signed with the vendor's Ed25519 key; the server only needs the public key. The demo
// environment runs without a license; a pilot without one runs as an evaluation with small limits.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { LicenseStatus } from '@13store/shared';

export interface LicenseBody {
  v: 1;
  /** Organisation id the license is issued to, or '*' for any org on this server. */
  org: string;
  customer: string;
  issuedAt: number;
  expiresAt: number;
  limits: { sites: number; devices: number; users: number };
  features: string[];
}
export interface LicenseFile extends LicenseBody {
  sig: string;
}

/** Evaluation limits when no license file is configured (pilot environments only). */
export const EVALUATION: LicenseBody = { v: 1, org: '*', customer: 'Evaluation', issuedAt: 0, expiresAt: 0, limits: { sites: 1, devices: 10, users: 5 }, features: [] };
/** Days after expiry during which everything still works but the console warns. */
export const GRACE_DAYS = 14;

/** Stable serialisation: sorted keys, so the signature does not depend on key order. */
export function canonical(body: LicenseBody): string {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sortKeys(body));
}

export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

export function signLicense(body: LicenseBody, privateKeyPem: string): LicenseFile {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonical(body)), key).toString('base64url');
  return { ...body, sig };
}

export function verifyLicense(file: LicenseFile, publicKeyPem: string | KeyObject): { ok: true; body: LicenseBody } | { ok: false; reason: string } {
  const { sig, ...body } = file;
  if (!sig || typeof sig !== 'string') return { ok: false, reason: 'missing signature' };
  if (body.v !== 1 || !body.limits || typeof body.expiresAt !== 'number') return { ok: false, reason: 'malformed license' };
  try {
    const key = typeof publicKeyPem === 'string' ? createPublicKey(publicKeyPem) : publicKeyPem;
    const ok = verify(null, Buffer.from(canonical(body as LicenseBody)), key, Buffer.from(sig, 'base64url'));
    return ok ? { ok: true, body: body as LicenseBody } : { ok: false, reason: 'signature does not verify' };
  } catch (e) {
    return { ok: false, reason: `cannot verify: ${(e as Error).message}` };
  }
}

export class License {
  readonly body: LicenseBody;
  readonly problem?: string;
  readonly licensed: boolean;

  constructor(opts: { file?: string; publicKeyPem?: string; env: 'demo' | 'pilot' }) {
    if (opts.env === 'demo') {
      this.body = { ...EVALUATION, customer: 'Demo environment', limits: { sites: 1_000, devices: 10_000, users: 10_000 }, features: ['*'] };
      this.licensed = true;
      return;
    }
    if (!opts.file) {
      this.body = EVALUATION;
      this.licensed = false;
      return;
    }
    if (!existsSync(opts.file)) {
      this.body = EVALUATION;
      this.licensed = false;
      this.problem = `license file not found: ${opts.file}`;
      return;
    }
    if (!opts.publicKeyPem) {
      this.body = EVALUATION;
      this.licensed = false;
      this.problem = 'LICENSE_PUBLIC_KEY is not set';
      return;
    }
    let parsed: LicenseFile;
    try {
      parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as LicenseFile;
    } catch (e) {
      this.body = EVALUATION;
      this.licensed = false;
      this.problem = `license file unreadable: ${(e as Error).message}`;
      return;
    }
    const v = verifyLicense(parsed, opts.publicKeyPem);
    if (!v.ok) {
      this.body = EVALUATION;
      this.licensed = false;
      this.problem = v.reason;
      return;
    }
    this.body = v.body;
    this.licensed = true;
  }

  appliesTo(orgId: string) {
    return this.body.org === '*' || this.body.org === orgId;
  }

  /** Days left (negative after expiry); null for licenses that never expire (demo). */
  daysLeft(now: number) {
    if (!this.body.expiresAt) return null;
    return Math.floor((this.body.expiresAt - now) / 86_400_000);
  }

  state(now: number): LicenseStatus['state'] {
    if (!this.licensed) return 'evaluation';
    const d = this.daysLeft(now);
    if (d === null) return 'valid';
    if (d < -GRACE_DAYS) return 'expired';
    if (d < 0) return 'grace';
    if (d <= 30) return 'expiring';
    return 'valid';
  }

  hasFeature(f: string) {
    return this.body.features.includes('*') || this.body.features.includes(f);
  }

  status(now: number, usage: LicenseStatus['usage'], orgId: string): LicenseStatus {
    return {
      state: this.state(now),
      customer: this.body.customer,
      org: this.body.org,
      appliesToOrg: this.appliesTo(orgId),
      expiresAt: this.body.expiresAt || undefined,
      daysLeft: this.daysLeft(now) ?? undefined,
      limits: this.body.limits,
      usage,
      features: this.body.features,
      problem: this.problem,
    };
  }

  /** Throws (as an { status, message }) when adding one more `kind` would exceed the license. */
  check(kind: keyof LicenseBody['limits'], current: number, now: number): string | null {
    const st = this.state(now);
    if (st === 'expired') return `License for ${this.body.customer} expired ${-this.daysLeft(now)!} days ago. Renew it to add ${kind}.`;
    if (current + 1 > this.body.limits[kind])
      return `License limit reached: ${this.body.limits[kind]} ${kind}${this.licensed ? '' : ' (evaluation)'}. Contact 13STORE to extend it.`;
    return null;
  }
}
