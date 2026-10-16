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
  constructor(private max = 5, private lockMs = 60_000) {}
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
