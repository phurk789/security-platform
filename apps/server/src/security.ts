import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function sha256(data: string | Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(prefix = '', bytes = 24) {
  return prefix + randomBytes(bytes).toString('base64url');
}

/** scrypt password hash: `scrypt$N$salt$hash`. */
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(password, salt, 32, { N: 16384 }).toString('base64url');
  return `scrypt$16384$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(password, salt, 32, { N: Number(n) });
  const want = Buffer.from(hash, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function hmac(secret: string, data: string) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Simple lockout after repeated failed logins. */
export class LoginThrottle {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(
    private max = 5,
    private lockMs = 60_000,
  ) {}
  blocked(key: string, now: number) {
    const f = this.fails.get(key);
    return !!f && f.until > now;
  }
  fail(key: string, now: number) {
    const f = this.fails.get(key) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= this.max) {
      f.until = now + this.lockMs;
      f.n = 0;
    }
    this.fails.set(key, f);
  }
  ok(key: string) {
    this.fails.delete(key);
  }
}

/** Fixed-window request counter per key (client address). Enough to blunt brute force and floods on one node. */
export class RateLimiter {
  private hits = new Map<string, { n: number; windowStart: number }>();
  constructor(private windowMs = 60_000) {}
  /** Counts one hit; returns how long to wait when over the limit (seconds), else 0. */
  hit(key: string, limit: number, now: number): number {
    if (limit <= 0) return 0;
    let h = this.hits.get(key);
    if (!h || now - h.windowStart >= this.windowMs) {
      h = { n: 0, windowStart: now };
      this.hits.set(key, h);
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
    }
    h.n += 1;
    return h.n > limit ? Math.max(1, Math.ceil((h.windowStart + this.windowMs - now) / 1000)) : 0;
  }
}
