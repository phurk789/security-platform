// A minimal OpenID Connect provider for tests: discovery, authorize (auto-consent), token with
// PKCE check, JWKS. Issues RS256 id_tokens with whatever claims the test configures.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface FakeOidc {
  issuer: string;
  server: Server;
  /** Claims put in the next id_token (sub, email, name, groups…). */
  claims: Record<string, unknown>;
  /** Last authorize request (state, nonce…). */
  last: { state?: string; nonce?: string; challenge?: string; code?: string };
  tokens: number;
  close(): Promise<void>;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startFakeOidc(clientId = 'ps-console', clientSecret = 'ps-secret'): Promise<FakeOidc> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const fake: Partial<FakeOidc> & { claims: Record<string, unknown>; last: FakeOidc['last']; tokens: number } = {
    claims: { sub: 'sso-user-1', email: 'alex.sso@example.com', name: 'Alex SSO', groups: ['SecurityOps'] },
    last: {},
    tokens: 0,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: fake.issuer, authorization_endpoint: `${fake.issuer}/authorize`, token_endpoint: `${fake.issuer}/token`, jwks_uri: `${fake.issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const state = url.searchParams.get('state') ?? '';
      const nonce = url.searchParams.get('nonce') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const code = `code-${codes.size + 1}`;
      codes.set(code, { nonce, challenge });
      fake.last = { state, nonce, challenge, code };
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const c = codes.get(f.get('code') ?? '');
        if (!c) return json({ error: 'invalid_grant' }, 400);
        if (f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return json({ error: 'invalid_client' }, 401);
        if (
          b64u(
            createHash('sha256')
              .update(f.get('code_verifier') ?? '')
              .digest(),
          ) !== c.challenge
        )
          return json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
        codes.delete(f.get('code')!);
        const now = Math.floor(Date.now() / 1000);
        const payload = { iss: fake.issuer, aud: clientId, iat: now, exp: now + 300, nonce: c.nonce, ...fake.claims };
        const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
        const pl = b64u(JSON.stringify(payload));
        const sig = b64u(sign('sha256', Buffer.from(`${head}.${pl}`), privateKey));
        fake.tokens++;
        json({ access_token: 'at', token_type: 'Bearer', id_token: `${head}.${pl}.${sig}` });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  fake.issuer = `http://127.0.0.1:${port}`;
  fake.server = server;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake as FakeOidc;
}
