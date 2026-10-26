// Gateway-declared stream URLs are not trusted (capability matrix §8, ADR-005). Before such a URL is
// stored, handed to a browser or fetched by the server, it must sit on an edge media origin that an
// administrator allowed for the site or the organisation. Loopback, link-local, metadata and other
// non-unicast addresses are refused even if someone puts them on the list.
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { StreamInfo } from '@13store/shared';

/** Host names of cloud instance-metadata services. */
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);

/** Why this host may never be an edge media origin; undefined when it may (if allowlisted). */
export function blockedHost(hostname: string): string | undefined {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return 'empty host';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (METADATA_NAMES.has(h)) return 'cloud metadata';
  const v = isIP(h);
  if (v === 4) return blockedV4(h.split('.').map(Number));
  if (v === 6) return blockedV6(h);
  return undefined;
}

function blockedV4([a, b, c, d]: number[]): string | undefined {
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return c === 169 && d === 254 ? 'cloud metadata' : 'link-local';
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'cloud metadata';
  if (a >= 224) return 'multicast or reserved';
  return undefined;
}

function blockedV6(h: string): string | undefined {
  const g = expandV6(h);
  if (!g) return 'unparseable IPv6';
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return 'cloud metadata';
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (mapped || nat64) return blockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  return undefined;
}

/** Eight 16-bit groups of an IPv6 literal (with optional trailing dotted quad), or null. */
function expandV6(h: string): number[] | null {
  let s = h.split('%')[0];
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) {
    const [p, q, r, t] = quad.slice(1).map(Number);
    s = `${s.slice(0, quad.index)}${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return parts.map((x) => parseInt(x, 16));
}

/** An administrator's allowlist entry: an http(s) origin with no path, credentials or blocked host. */
export function parseEdgeOrigin(raw: unknown): { origin: string } | { error: string } {
  const bad = { error: `"${String(raw).slice(0, 80)}" must be an origin such as https://edge.site.example:8889` };
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) return bad;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return bad;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `${u.origin}: only http and https origins` };
  if (u.username || u.password) return { error: `${u.host}: no credentials in an origin` };
  if (u.pathname !== '/' || u.search || u.hash) return { error: `${u.origin}: origin only, without a path or query` };
  const why = blockedHost(u.hostname);
  if (why) return { error: `${u.host}: ${why} addresses are never allowed` };
  return { origin: u.origin };
}

/** A gateway-declared URL that may be used: http(s), no credentials, host not blocked, origin allowlisted. */
export function checkDeclaredUrl(raw: unknown, allowed: readonly string[]): { url: string } | { error: string } {
  if (typeof raw !== 'string' || !raw || raw.length > 300) return { error: 'not a URL' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'not a URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `${u.protocol} is not http or https` };
  if (u.username || u.password) return { error: 'credentials in the URL' };
  const why = blockedHost(u.hostname);
  if (why) return { error: `${u.host} is a ${why} address` };
  if (!allowed.includes(u.origin)) return { error: `${u.origin} is not an allowed edge origin for this site` };
  return { url: u.href };
}

/** Stream fields a browser plays or the server fetches. */
export const EDGE_STREAM_KEYS = ['whep', 'hls', 'whepSub', 'hlsSub', 'playback'] as const;

/**
 * Keeps the stream URLs that pass `checkDeclaredUrl`. RTSP sources (device network, never fetched by
 * the server or played by a browser) are kept for display without any user:password part.
 */
export function vetStream(raw: unknown, allowed: readonly string[], keys: readonly string[] = EDGE_STREAM_KEYS): { stream?: StreamInfo; rejected: string[] } {
  const src = raw as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') return { rejected: [] };
  const out: Record<string, string> = {};
  const rejected: string[] = [];
  for (const k of keys) {
    if (src[k] === undefined) continue;
    const r = checkDeclaredUrl(src[k], allowed);
    if ('url' in r) out[k] = r.url;
    else rejected.push(`${k}: ${r.error}`);
  }
  for (const k of ['rtsp', 'rtspSub']) {
    const v = src[k];
    if (typeof v !== 'string' || v.length > 300) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== 'rtsp:' && u.protocol !== 'rtsps:') continue;
      u.username = '';
      u.password = '';
      out[k] = u.href;
    } catch {
      /* not a URL: dropped */
    }
  }
  return { stream: Object.keys(out).length ? (out as StreamInfo) : undefined, rejected };
}

// ---------------------------------------------------------------------------
// Server-side fetch from an edge media server
// ---------------------------------------------------------------------------

export interface EdgeResponse {
  status: number;
  body: Buffer;
}

export type EdgeGet = (url: string, opts: { timeoutMs: number; maxBytes: number }) => Promise<EdgeResponse>;

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that fails when the name resolves to an address `blockedHost` refuses. */
export function checkedLookup(hostname: string, options: LookupOptions, cb: LookupCb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as LookupAddress[];
    const bad = list.find((x) => blockedHost(x.address));
    if (bad || !list.length) {
      const e = new Error(`${hostname} resolves to a ${bad ? blockedHost(bad.address) : 'missing'} address; refused`) as NodeJS.ErrnoException;
      e.code = 'EBLOCKED';
      return cb(e, '');
    }
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/**
 * GET from an edge media server. The socket connects to an address checked by `checkedLookup`
 * (so a name cannot be re-pointed between the check and the connection), redirects are not
 * followed, and the body is capped.
 */
export const edgeGet: EdgeGet = (url, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('not a URL'));
    }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new Error(`${u.protocol} is not http or https`));
    const why = blockedHost(u.hostname);
    if (why) return reject(new Error(`${u.host} is a ${why} address`));
    const req = mod.request(u, { method: 'GET', lookup: checkedLookup as never, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error(`response larger than ${Math.round(maxBytes / 1048576)} MB`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
