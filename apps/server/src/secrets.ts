// Secrets at rest. Values the platform must be able to use again (webhook signing secrets, LINE
// tokens, SMS gateway headers) are sealed with AES-256-GCM before they go into the database, so a
// copied database file or backup does not give them away. The key comes from SECRETS_KEY (32 bytes,
// hex or base64) or is generated once into DATA_DIR/secrets.key (mode 0600). Keep that file with
// the backups: without it sealed values cannot be opened on another host.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PREFIX = 'enc:v1:';
let key: Buffer | null = null;
let warned = false;

function parseKey(raw: string): Buffer {
  const t = raw.trim();
  const b = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (b.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes (64 hex characters or 44 base64 characters).');
  return b;
}

/** Loads or creates the key. Called once at start-up. */
export function initSecrets(opts: { key?: string; dataDir: string }) {
  if (opts.key) {
    key = parseKey(opts.key);
    return { source: 'env' as const };
  }
  const file = join(opts.dataDir, 'secrets.key');
  if (existsSync(file)) {
    key = parseKey(readFileSync(file, 'utf8'));
    return { source: 'file' as const, file };
  }
  mkdirSync(dirname(file), { recursive: true });
  key = randomBytes(32);
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
  return { source: 'generated' as const, file };
}

export function secretsReady() {
  return key !== null;
}

/** Plain text → `enc:v1:<iv>:<tag>:<ciphertext>` (base64url). Already sealed values pass through. */
export function seal(plain: string): string {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  if (!key) {
    if (!warned) {
      warned = true;
      console.warn('[secrets] no key initialised; storing secrets in clear');
    }
    return plain;
  }
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/** Sealed → plain. Values stored in clear (before sealing existed) come back unchanged. */
export function open(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  if (!key) throw new Error('A sealed secret cannot be opened: SECRETS_KEY / secrets.key is missing.');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const isSealed = (v: unknown) => typeof v === 'string' && v.startsWith(PREFIX);
