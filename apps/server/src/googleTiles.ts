// Google Maps basemaps through the official Map Tiles API (2D tiles), proxied by the server so the
// API key never reaches a browser. Off unless GOOGLE_MAPS_API_KEY is set. Using it needs a Google
// Maps Platform project with the Map Tiles API enabled, billing, and acceptance of Google's terms
// (attribution: the "Google Maps" mark plus the viewport copyright text, which the console shows).
// Unofficial tile URLs (mt*.google.com and the like) are never used.

export interface ServerBasemap {
  id: string;
  label: string;
  /** Tile URL template on this server ({z}/{x}/{y}). */
  tiles: string[];
  attribution: string;
  maxzoom: number;
  provider: 'google';
}

interface StyleSpec {
  label: string;
  body: Record<string, unknown>;
}

/** Google map styles offered (createSession bodies). Hybrid = satellite + roadmap labels, no overlay. */
export const GOOGLE_STYLES: Record<string, StyleSpec> = {
  'google-api-satellite': { label: 'Google satellite (official API)', body: { mapType: 'satellite' } },
  'google-api-hybrid': { label: 'Google satellite + labels (official API)', body: { mapType: 'satellite', layerTypes: ['layerRoadmap'], overlay: false } },
  'google-api-roadmap': { label: 'Google Maps roads (official API)', body: { mapType: 'roadmap' } },
};

/** Renew a session this long before Google says it expires (sessions last about two weeks). */
const RENEW_BEFORE_MS = 60 * 60_000;
const TIMEOUT_MS = 10_000;

export interface TileResult {
  status: number;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
  etag?: string;
}

type Fetch = typeof fetch;

export class GoogleTiles {
  private sessions = new Map<string, { token: string; expMs: number }>();
  private pending = new Map<string, Promise<string>>();

  constructor(
    private key: string,
    private base = 'https://tile.googleapis.com',
    private opts: { fetch?: Fetch; now?: () => number; language?: string; region?: string; log?: (m: string) => void } = {},
  ) {}

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** The basemaps this server offers, for the console's basemap list. */
  basemaps(): ServerBasemap[] {
    return Object.entries(GOOGLE_STYLES).map(([id, s]) => ({
      id,
      label: s.label,
      tiles: [`/api/v1/basemaps/${id}/tiles/{z}/{x}/{y}`],
      // The console shows the "Google Maps" mark and the viewport copyright itself (see /attribution).
      attribution: '',
      maxzoom: 22,
      provider: 'google',
    }));
  }

  /** A valid session token for a style, created once and shared by every viewer until it nears expiry. */
  async session(style: string, fresh = false): Promise<string> {
    const s = this.sessions.get(style);
    if (!fresh && s && s.expMs - this.now() > RENEW_BEFORE_MS) return s.token;
    const inFlight = this.pending.get(style);
    if (inFlight) return inFlight;
    const p = (async () => {
      const spec = GOOGLE_STYLES[style];
      const res = await this.fetch(`${this.base}/v1/createSession?key=${encodeURIComponent(this.key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: this.opts.language ?? 'th', region: this.opts.region ?? 'TH', ...spec.body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Google createSession answered ${res.status}${await reason(res)}`);
      const j = (await res.json()) as { session?: string; expiry?: string };
      if (!j.session) throw new Error('Google createSession returned no session');
      const expMs = Number(j.expiry) * 1000 || this.now() + 24 * 3600_000;
      this.sessions.set(style, { token: j.session, expMs });
      return j.session;
    })();
    this.pending.set(style, p);
    try {
      return await p;
    } finally {
      this.pending.delete(style);
    }
  }

  /** One 2D tile. A rejected session is renewed once (Google may end sessions early). */
  async tile(style: string, z: number, x: number, y: number): Promise<TileResult> {
    let r = await this.getTile(style, z, x, y, await this.session(style));
    if (r.status === 400 || r.status === 401 || r.status === 403) r = await this.getTile(style, z, x, y, await this.session(style, true));
    return r;
  }

  private async getTile(style: string, z: number, x: number, y: number, session: string): Promise<TileResult> {
    const res = await this.fetch(`${this.base}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(this.key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok && res.status !== 404) this.opts.log?.(`[google] tile ${style} ${z}/${x}/${y}: ${res.status}`);
    return {
      status: res.status,
      body,
      contentType: res.headers.get('content-type') ?? 'image/png',
      cacheControl: res.headers.get('cache-control') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
    };
  }

  /** Copyright text Google requires for what is on screen. */
  async attribution(style: string, v: { zoom: number; north: number; south: number; east: number; west: number }): Promise<string> {
    const q = new URLSearchParams({ session: await this.session(style), key: this.key, zoom: String(v.zoom), north: String(v.north), south: String(v.south), east: String(v.east), west: String(v.west) });
    const res = await this.fetch(`${this.base}/tile/v1/viewport?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Google viewport answered ${res.status}`);
    const j = (await res.json()) as { copyright?: string };
    return j.copyright ?? '';
  }
}

/** A short reason from a Google error body, without echoing the request (which carries the key). */
async function reason(res: Response) {
  try {
    const j = (await res.json()) as { error?: { status?: string; message?: string } };
    return j.error?.status ? ` (${j.error.status})` : '';
  } catch {
    return '';
  }
}

/** z/x/y as integers inside the tile pyramid, or undefined. */
export function tileXYZ(z: unknown, x: unknown, y: unknown) {
  const [zz, xx, yy] = [z, x, y].map((v) => (typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : NaN));
  if (!(zz >= 0 && zz <= 22)) return undefined;
  const n = 2 ** zz;
  if (!(xx >= 0 && xx < n && yy >= 0 && yy < n)) return undefined;
  return { z: zz, x: xx, y: yy };
}
