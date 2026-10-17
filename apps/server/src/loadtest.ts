// Load-test harness for the TOR §9 quality targets (event shown ≤ 2 s p95; ≥ 100 cameras / 50
// devices per site). It drives a RUNNING server the way a pilot site would: edge gateways send
// telemetry for cameras and vehicles, dispatcher consoles listen on the console WebSocket, and
// incidents are raised over the API. Everything runs in this one process on one clock, so a
// latency is console receipt − gateway send and includes the server and both sockets.
//
//   const report = await runLoadTest({ url: 'http://127.0.0.1:8080', gateways: 4, devices: 120, ugvs: 20, consoles: 10, durationS: 60 });
//   console.log(reportMarkdown(report));
//
// The harness only adds devices named LT-CAM-nnn / LT-UGV-nnn (registered once, reused after)
// and incidents titled "Load test <run> #n". Run it against a throwaway data directory, never a
// production server.
import WebSocket from 'ws';
import { GATEWAY_PROTOCOL, type AdapterDeclaration, type ConsoleMessage, type GwHello, type GwTelemetry, type Point } from '@13store/shared';

export interface LoadTestOptions {
  /** Server base URL, e.g. http://127.0.0.1:8080. */
  url: string;
  /** Gateway WebSockets to open; the devices are shared out between them. Default 2. */
  gateways?: number;
  /** Load devices in total (cameras + UGVs). Default 40. */
  devices?: number;
  /** How many of the devices are UGVs; the rest are cameras. Default ⌊devices / 6⌋. */
  ugvs?: number;
  /** Dispatcher console WebSockets to open. Default 4. */
  consoles?: number;
  /** Telemetry interval per device in ms. Default 1000. */
  rateMs?: number;
  /** How long telemetry is sent, in seconds. Default 30. */
  durationS?: number;
  /** Incidents created per minute (the first one right at the start). Default 6. */
  incidentsPerMin?: number;
  /** Administrator who registers the load devices and reads the metrics. Default ploy / demo1234. */
  admin?: { username: string; password: string };
  /** Dispatcher whose sessions the consoles use and who creates incidents. Default alex / demo1234. */
  consoleUser?: { username: string; password: string };
  /** Gateway API key. Default the demo key. */
  gatewayKey?: string;
  /** Site the devices and incidents belong to (default: the user's first site). */
  siteId?: string;
  /** Seconds to wait for in-flight events after the last telemetry is sent. Default 3. */
  drainS?: number;
  /** Interval between HTTP latency samples in ms. Default 1000. */
  httpSampleMs?: number;
  /** Progress lines. */
  log?: (line: string) => void;
  /** Ends the run early; the report covers what ran. */
  signal?: AbortSignal;
}

export interface LatencyStat {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface LoadReport {
  startedAt: string;
  finishedAt: string;
  /** Seconds telemetry was actually sent for. */
  durationS: number;
  profile: {
    url: string;
    gateways: number;
    devices: number;
    cameras: number;
    ugvs: number;
    consoles: number;
    rateMs: number;
    incidentsPerMin: number;
  };
  setup: { devicesRegistered: number; devicesReused: number; gatewaysConnected: number; consolesConnected: number; setupMs: number };
  telemetry: {
    /** Telemetry messages sent by the gateways. */
    sent: number;
    /** Deliveries expected = sent × connected consoles. */
    expected: number;
    received: number;
    /** Deliveries still missing after the drain window. */
    dropped: number;
    /** Console messages that matched nothing sent (late after the sweep, or duplicates). */
    unmatched: number;
    /** Telemetry not sent because a gateway socket was closed or its send buffer was full (back-pressure). */
    skipped: number;
    deliveryPct: number;
    /** Gateway send → console receipt. */
    latencyMs: LatencyStat;
  };
  incidents: {
    created: number;
    expected: number;
    received: number;
    dropped: number;
    /** POST sent → console 'incident' event received. */
    latencyMs: LatencyStat;
  };
  http: {
    getIncidents: LatencyStat & { errors: number };
    getSnapshot: LatencyStat & { errors: number };
    postIncident: LatencyStat & { errors: number };
  };
  errors: { count: number; samples: string[] };
  /** Lines of /api/v1/metrics for request counts, device freshness, gateways and console clients. */
  serverMetrics?: string[];
  /** TOR §9: event shown ≤ 2 s p95. */
  targets: { eventP95Ms: number; telemetryOk: boolean; incidentOk: boolean; pass: boolean };
}

const DEFAULTS = {
  gateways: 2,
  devices: 40,
  consoles: 4,
  rateMs: 1000,
  durationS: 30,
  incidentsPerMin: 6,
  admin: { username: 'ploy', password: 'demo1234' },
  consoleUser: { username: 'alex', password: 'demo1234' },
  gatewayKey: 'gw_demo_local_key',
  drainS: 3,
  httpSampleMs: 1000,
};

export const EVENT_P95_TARGET_MS = 2000;

/** Gateway send buffer above which a tick is skipped instead of queued (back-pressure). */
const SEND_BUFFER_LIMIT = 512 * 1024;
/** Pending telemetry older than this is written off as dropped so the registry cannot grow without bound. */
const PENDING_TTL_MS = 30_000;
const MAX_SAMPLES = 1_000_000;
const MAX_ERROR_SAMPLES = 40;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Latency samples with a bounded memory footprint (reservoir sampling past the cap). */
class Samples {
  private v: number[] = [];
  n = 0;
  constructor(private cap = MAX_SAMPLES) {}
  add(x: number) {
    this.n++;
    if (this.v.length < this.cap) this.v.push(x);
    else {
      const i = Math.floor(Math.random() * this.n);
      if (i < this.cap) this.v[i] = x;
    }
  }
  stat(): LatencyStat {
    return statOf(this.v, this.n);
  }
}

function statOf(values: number[], count = values.length): LatencyStat {
  if (!values.length) return { count, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  const r = (x: number) => Math.round(x * 10) / 10;
  return { count, p50: r(q(50)), p95: r(q(95)), p99: r(q(99)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: any;
  ms: number;
}

async function api(base: string, method: string, path: string, token?: string, body?: unknown): Promise<HttpResult> {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text body */
  }
  return { status: res.status, body: parsed, ms: performance.now() - t0 };
}

async function login(base: string, u: { username: string; password: string }): Promise<string> {
  const r = await api(base, 'POST', '/auth/login', undefined, u);
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${u.username} failed: ${r.status} ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}`);
  return r.body.token as string;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** Closes a socket and waits for the close frame, terminating it if the peer is slow. */
function closeSocket(ws: WebSocket, timeoutMs = 2000) {
  return new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const t = setTimeout(() => {
      ws.terminate();
      resolve();
    }, timeoutMs);
    ws.once('close', () => {
      clearTimeout(t);
      resolve();
    });
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(1000, 'load test finished');
  });
}

// ---------------------------------------------------------------------------
// Load devices and gateways
// ---------------------------------------------------------------------------

interface LoadDevice {
  id: string;
  kind: 'cctv' | 'ugv';
  home: Point;
  seq: number;
  lastSourceTime: number;
  phase: number;
}

function planDevices(cameras: number, ugvs: number): LoadDevice[] {
  const out: LoadDevice[] = [];
  const total = cameras + ugvs;
  const cols = Math.max(1, Math.ceil(Math.sqrt(total * 1.5)));
  const place = (i: number): Point => ({ x: 30 + (i % cols) * (540 / cols), y: 30 + Math.floor(i / cols) * (340 / Math.max(1, Math.ceil(total / cols))) });
  for (let i = 0; i < cameras; i++)
    out.push({ id: `LT-CAM-${String(i + 1).padStart(3, '0')}`, kind: 'cctv', home: place(i), seq: 0, lastSourceTime: 0, phase: Math.random() * Math.PI * 2 });
  for (let i = 0; i < ugvs; i++)
    out.push({ id: `LT-UGV-${String(i + 1).padStart(3, '0')}`, kind: 'ugv', home: place(cameras + i), seq: 0, lastSourceTime: 0, phase: Math.random() * Math.PI * 2 });
  return out;
}

function declaration(d: LoadDevice, rateMs: number): AdapterDeclaration {
  return {
    deviceId: d.id,
    kind: d.kind,
    model: d.kind === 'cctv' ? 'Load-test camera' : 'Load-test UGV',
    adapterVersion: 'loadtest/1',
    protocolVersion: 'sim/1',
    firmwareTested: 'n/a (load test)',
    integration: 'simulated',
    capabilities: d.kind === 'cctv' ? ['video'] : ['telemetry'],
    commands: [],
    units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
    rateMs,
    limitations: 'Synthetic load-test device; no commands.',
    linkLossBehavior: 'None (synthetic).',
  };
}

/** One sample for a device: cameras stand still, UGVs idle in a 2 m circle so they trigger no geofence. */
function sample(d: LoadDevice, now: number): GwTelemetry {
  d.seq += 1;
  const sourceTime = Math.max(now, d.lastSourceTime + 1);
  d.lastSourceTime = sourceTime;
  const a = d.phase + d.seq / 20;
  const pos = d.kind === 'ugv' ? { x: Math.round((d.home.x + 2 * Math.cos(a)) * 100) / 100, y: Math.round((d.home.y + 2 * Math.sin(a)) * 100) / 100 } : d.home;
  return {
    t: 'telemetry',
    deviceId: d.id,
    seq: d.seq,
    sourceTime,
    pos,
    accuracyM: d.kind === 'ugv' ? 1.5 : 0,
    battery: d.kind === 'ugv' ? 90 - (d.seq % 50) / 10 : undefined,
    speed: 0,
    quality: 'good',
    heading: d.kind === 'ugv' ? Math.round(((a * 180) / Math.PI) % 360) : undefined,
    signal: 95,
    temperatureC: 38 + (d.seq % 7) / 10,
  };
}

/** Telemetry sent and not yet seen by every console. */
interface Pending {
  sentAt: number;
  left: number;
}

class Run {
  errors: string[] = [];
  errorCount = 0;
  telemetryLatency = new Samples();
  incidentLatency = new Samples();
  getIncidents = new Samples();
  getSnapshot = new Samples();
  postIncident = new Samples();
  httpErrors = { getIncidents: 0, getSnapshot: 0, postIncident: 0 };
  pending = new Map<string, Pending>();
  pendingIncidents = new Map<string, Pending>();
  sent = 0;
  received = 0;
  dropped = 0;
  unmatched = 0;
  skipped = 0;
  incidentsCreated = 0;
  incidentsReceived = 0;
  incidentsDropped = 0;
  consolesConnected = 0;
  readonly runId = Math.random().toString(36).slice(2, 8);

  constructor(public log: (line: string) => void) {}

  error(msg: string) {
    this.errorCount++;
    if (this.errors.length < MAX_ERROR_SAMPLES) this.errors.push(msg);
    this.log(`error: ${msg}`);
  }

  /** Writes off pending telemetry older than the TTL so the registry stays bounded on long runs. */
  sweep(now: number) {
    for (const [k, p] of this.pending) {
      if (now - p.sentAt > PENDING_TTL_MS) {
        this.dropped += p.left;
        this.pending.delete(k);
      }
    }
  }

  /** Everything still pending at the end counts as dropped. */
  finish() {
    for (const p of this.pending.values()) this.dropped += p.left;
    this.pending.clear();
    for (const p of this.pendingIncidents.values()) this.incidentsDropped += p.left;
    this.pendingIncidents.clear();
  }
}

class LoadGateway {
  ws?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private reconnecting = false;

  constructor(
    readonly id: string,
    readonly devices: LoadDevice[],
    private wsUrl: string,
    private key: string,
    private rateMs: number,
    private run: Run,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${this.key}` } });
    this.ws = ws;
    const welcome = await new Promise<{ accepted: string[]; rejected: { deviceId: string; reason: string }[] }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.id}: no welcome within 15 s`)), 15_000);
      ws.once('open', () => {
        const hello: GwHello = { t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId: this.id, adapters: this.devices.map((d) => declaration(d, this.rateMs)) };
        ws.send(JSON.stringify(hello));
      });
      ws.once('message', (raw) => {
        clearTimeout(t);
        try {
          const m = JSON.parse(String(raw));
          if (m.t !== 'welcome') return reject(new Error(`${this.id}: expected welcome, got ${m.t}`));
          resolve(m);
        } catch (e) {
          reject(e);
        }
      });
      ws.once('error', (e) => {
        clearTimeout(t);
        reject(new Error(`${this.id}: ${e.message}`));
      });
      ws.once('close', (code, reason) => {
        clearTimeout(t);
        reject(new Error(`${this.id}: closed before welcome (${code} ${String(reason)})`));
      });
    });
    for (const r of welcome.rejected) this.run.error(`${this.id}: ${r.deviceId} rejected: ${r.reason}`);
    const accepted = new Set(welcome.accepted);
    const missing = this.devices.filter((d) => !accepted.has(d.id) && !welcome.rejected.some((r) => r.deviceId === d.id));
    for (const d of missing) this.run.error(`${this.id}: ${d.id} neither accepted nor rejected`);
    ws.on('error', (e) => this.run.error(`${this.id}: socket error: ${e.message}`));
    ws.on('close', (code, reason) => {
      if (this.closed) return;
      this.run.error(`${this.id}: connection closed (${code} ${String(reason)})`);
      void this.reconnect();
    });
  }

  private async reconnect() {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    for (let attempt = 1; attempt <= 3 && !this.closed; attempt++) {
      await sleep(500 * attempt);
      if (this.closed) break;
      try {
        await this.connect();
        this.run.log(`${this.id}: reconnected`);
        break;
      } catch (e) {
        this.run.error(`${this.id}: reconnect ${attempt} failed: ${(e as Error).message}`);
      }
    }
    this.reconnecting = false;
  }

  start(consoles: number) {
    this.timer = setInterval(() => this.tick(consoles), this.rateMs);
  }

  private tick(consoles: number) {
    const ws = this.ws;
    // Back-pressure: a closed socket or a full send buffer skips this tick instead of queueing more.
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > SEND_BUFFER_LIMIT) {
      this.run.skipped += this.devices.length;
      return;
    }
    const now = Date.now();
    for (const d of this.devices) {
      const t = sample(d, now);
      const sentAt = performance.now();
      ws.send(JSON.stringify(t));
      this.run.sent++;
      if (consoles > 0) this.run.pending.set(`${d.id}|${t.sourceTime}`, { sentAt, left: consoles });
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async close() {
    this.closed = true;
    this.stop();
    if (this.ws) await closeSocket(this.ws);
  }
}

class LoadConsole {
  ws?: WebSocket;
  received = 0;
  private seenIncidents = new Set<string>();
  private closed = false;

  constructor(
    readonly idx: number,
    private wsUrl: string,
    private token: string,
    private run: Run,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.wsUrl}/api/v1/ws`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`console ${this.idx}: no hello within 15 s`)), 15_000);
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token: this.token })));
      const onFirst = (raw: WebSocket.RawData) => {
        let m: ConsoleMessage;
        try {
          m = JSON.parse(String(raw));
        } catch (e) {
          return reject(e);
        }
        if (m.type !== 'hello') return reject(new Error(`console ${this.idx}: expected hello, got ${m.type}`));
        clearTimeout(t);
        ws.off('message', onFirst);
        ws.on('message', (data) => this.onMessage(data));
        resolve();
      };
      ws.on('message', onFirst);
      ws.once('error', (e) => {
        clearTimeout(t);
        reject(new Error(`console ${this.idx}: ${e.message}`));
      });
      ws.once('close', (code, reason) => {
        clearTimeout(t);
        reject(new Error(`console ${this.idx}: closed before hello (${code} ${String(reason)})`));
      });
    });
    ws.on('error', (e) => this.run.error(`console ${this.idx}: socket error: ${e.message}`));
    ws.on('close', (code, reason) => {
      if (!this.closed) this.run.error(`console ${this.idx}: connection closed (${code} ${String(reason)})`);
    });
  }

  private onMessage(raw: WebSocket.RawData) {
    const now = performance.now();
    let m: ConsoleMessage;
    try {
      m = JSON.parse(String(raw));
    } catch {
      this.run.error(`console ${this.idx}: unparseable message`);
      return;
    }
    if (m.type === 'telemetry') {
      // The console event carries the sample's sourceTime as `at`; the harness stamps it uniquely per device, so deviceId + at identifies deviceId + seq.
      const key = `${m.deviceId}|${m.at}`;
      const p = this.run.pending.get(key);
      if (!p) {
        if (m.deviceId.startsWith('LT-')) this.run.unmatched++;
        return;
      }
      this.received++;
      this.run.received++;
      this.run.telemetryLatency.add(now - p.sentAt);
      if (--p.left <= 0) this.run.pending.delete(key);
    } else if (m.type === 'incident') {
      const match = /^Load test (\w+) #(\d+)$/.exec(m.incident.title);
      if (!match || match[1] !== this.run.runId) return;
      const key = match[2];
      if (this.seenIncidents.has(key)) return;
      const p = this.run.pendingIncidents.get(key);
      if (!p) return;
      this.seenIncidents.add(key);
      this.run.incidentsReceived++;
      this.run.incidentLatency.add(now - p.sentAt);
      if (--p.left <= 0) this.run.pendingIncidents.delete(key);
    }
  }

  async close() {
    this.closed = true;
    if (this.ws) await closeSocket(this.ws);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runLoadTest(opts: LoadTestOptions): Promise<LoadReport> {
  const o = {
    ...DEFAULTS,
    ...opts,
    gateways: Math.max(1, Math.floor(opts.gateways ?? DEFAULTS.gateways)),
    devices: Math.max(1, Math.floor(opts.devices ?? DEFAULTS.devices)),
    consoles: Math.max(0, Math.floor(opts.consoles ?? DEFAULTS.consoles)),
    rateMs: Math.max(20, Math.floor(opts.rateMs ?? DEFAULTS.rateMs)),
    durationS: Math.max(1, opts.durationS ?? DEFAULTS.durationS),
    incidentsPerMin: Math.max(0, opts.incidentsPerMin ?? DEFAULTS.incidentsPerMin),
  };
  const ugvs = Math.min(o.devices, Math.max(0, Math.floor(opts.ugvs ?? o.devices / 6)));
  const cameras = o.devices - ugvs;
  const base = o.url.replace(/\/+$/, '');
  const wsUrl = base.replace(/^http/, 'ws');
  const log = o.log ?? (() => {});
  const run = new Run(log);
  const startedAt = new Date();
  const t0 = performance.now();

  // 1. Sessions.
  const adminToken = await login(base, o.admin);
  const dispatcherToken = await login(base, o.consoleUser);
  const consoleTokens: string[] = [];
  for (let i = 0; i < o.consoles; i++) {
    try {
      consoleTokens.push(i === 0 ? dispatcherToken : await login(base, o.consoleUser));
    } catch (e) {
      // Sign-in is rate limited per address; a console that cannot get its own session shares one.
      run.log(`console ${i}: ${(e as Error).message}; sharing a session`);
      consoleTokens.push(dispatcherToken);
    }
  }

  // 2. Devices (registered once; later runs reuse them).
  const devices = planDevices(cameras, ugvs);
  const existing = await api(base, 'GET', `/devices${o.siteId ? `?siteId=${encodeURIComponent(o.siteId)}` : ''}`, adminToken);
  if (existing.status !== 200) throw new Error(`GET /devices failed: ${existing.status} ${JSON.stringify(existing.body)}`);
  const have = new Set((existing.body as { id: string }[]).map((d) => d.id));
  let registered = 0;
  let reused = 0;
  await pooled(
    devices.filter((d) => !have.has(d.id)),
    8,
    async (d) => {
      const r = await api(base, 'POST', '/devices', adminToken, {
        id: d.id,
        kind: d.kind,
        model: d.kind === 'cctv' ? 'Load-test camera' : 'Load-test UGV',
        pos: d.home,
        ...(o.siteId ? { siteId: o.siteId } : {}),
      });
      if (r.status === 200) registered++;
      else if (r.status === 409) reused++;
      else run.error(`register ${d.id}: ${r.status} ${JSON.stringify(r.body)}`);
    },
  );
  reused += devices.filter((d) => have.has(d.id)).length;
  log(`devices: ${registered} registered, ${reused} already there (${cameras} cameras, ${ugvs} UGVs)`);

  // 3. Gateways and consoles.
  const gateways: LoadGateway[] = [];
  for (let g = 0; g < o.gateways; g++) {
    const share = devices.filter((_, i) => i % o.gateways === g);
    if (share.length) gateways.push(new LoadGateway(`lt-gw-${String(g + 1).padStart(2, '0')}`, share, wsUrl, o.gatewayKey, o.rateMs, run));
  }
  const consoles = consoleTokens.map((tok, i) => new LoadConsole(i + 1, wsUrl, tok, run));
  const results = await Promise.allSettled([...gateways.map((g) => g.connect()), ...consoles.map((c) => c.connect())]);
  const connectedGateways: LoadGateway[] = [];
  const connectedConsoles: LoadConsole[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') return run.error(`connect: ${(r.reason as Error).message}`);
    if (i < gateways.length) connectedGateways.push(gateways[i]);
    else connectedConsoles.push(consoles[i - gateways.length]);
  });
  run.consolesConnected = connectedConsoles.length;
  const setupMs = performance.now() - t0;
  log(`connected: ${connectedGateways.length}/${gateways.length} gateways, ${connectedConsoles.length}/${consoles.length} consoles (setup ${Math.round(setupMs)} ms)`);

  // 4. Traffic.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let running = true;
  const every = (ms: number, fn: () => Promise<void> | void, immediate = false) => {
    const loop = async () => {
      if (!running) return;
      try {
        await fn();
      } catch (e) {
        run.error(`loop: ${(e as Error).message}`);
      }
      if (running) timers.add(setTimeout(loop, ms));
    };
    timers.add(setTimeout(loop, immediate ? 0 : ms));
  };

  // Gateways tick at the same rate, staggered so their bursts do not coincide.
  connectedGateways.forEach((g, i) => timers.add(setTimeout(() => running && g.start(run.consolesConnected), Math.floor((o.rateMs / Math.max(1, connectedGateways.length)) * i))));

  if (o.incidentsPerMin > 0) {
    every(
      Math.max(1000, Math.round(60_000 / o.incidentsPerMin)),
      async () => {
        const n = ++run.incidentsCreated;
        const key = String(n);
        const sentAt = performance.now();
        if (run.consolesConnected > 0) run.pendingIncidents.set(key, { sentAt, left: run.consolesConnected });
        const r = await api(base, 'POST', '/incidents', dispatcherToken, {
          title: `Load test ${run.runId} #${n}`,
          type: 'Load test',
          severity: 'low',
          place: 'Load test',
          source: 'Load-test harness',
          noAutoAim: true,
          ...(o.siteId ? { siteId: o.siteId } : {}),
        });
        run.postIncident.add(r.ms);
        if (r.status !== 200) {
          run.httpErrors.postIncident++;
          run.pendingIncidents.delete(key);
          run.incidentsCreated--;
          run.error(`POST /incidents: ${r.status} ${JSON.stringify(r.body)}`);
        }
      },
      true,
    );
  }

  every(o.httpSampleMs, async () => {
    const a = await api(base, 'GET', '/incidents?limit=100', dispatcherToken);
    run.getIncidents.add(a.ms);
    if (a.status !== 200) {
      run.httpErrors.getIncidents++;
      run.error(`GET /incidents: ${a.status}`);
    }
    const b = await api(base, 'GET', `/snapshot${o.siteId ? `?siteId=${encodeURIComponent(o.siteId)}` : ''}`, dispatcherToken);
    run.getSnapshot.add(b.ms);
    if (b.status !== 200) {
      run.httpErrors.getSnapshot++;
      run.error(`GET /snapshot: ${b.status}`);
    }
  });

  every(5000, () => {
    run.sweep(performance.now());
    const el = Math.round((performance.now() - t0 - setupMs) / 1000);
    log(
      `${el} s: telemetry sent ${run.sent}, received ${run.received}, pending ${run.pending.size}, incidents ${run.incidentsReceived}/${run.incidentsCreated * run.consolesConnected}, errors ${run.errorCount}`,
    );
  });

  const sendStart = performance.now();
  await sleep(o.durationS * 1000, o.signal);
  const durationS = Math.round((performance.now() - sendStart) / 100) / 10;
  for (const g of connectedGateways) g.stop();
  running = false;
  for (const t of timers) clearTimeout(t);
  log(`sending stopped after ${durationS} s; draining ${o.drainS} s`);
  await sleep(o.drainS * 1000);
  run.finish();

  // 5. Server-side view.
  let serverMetrics: string[] | undefined;
  try {
    const m = await api(base, 'GET', '/metrics', adminToken);
    if (m.status === 200 && typeof m.body === 'string')
      serverMetrics = m.body
        .split('\n')
        .filter((l) => /^(ps_http_requests_total|ps_devices|ps_console_clients|ps_gateways_connected|ps_http_request_duration_seconds_(sum|count))\b/.test(l));
  } catch {
    /* metrics are optional */
  }

  // 6. Shutdown.
  await Promise.all([...gateways.map((g) => g.close()), ...consoles.map((c) => c.close())]);

  const telemetry = run.telemetryLatency.stat();
  const incidents = run.incidentLatency.stat();
  const expected = run.sent * run.consolesConnected;
  const telemetryOk = telemetry.count > 0 && telemetry.p95 <= EVENT_P95_TARGET_MS;
  const incidentOk = o.incidentsPerMin === 0 || (incidents.count > 0 && incidents.p95 <= EVENT_P95_TARGET_MS);
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationS,
    profile: { url: base, gateways: o.gateways, devices: o.devices, cameras, ugvs, consoles: o.consoles, rateMs: o.rateMs, incidentsPerMin: o.incidentsPerMin },
    setup: {
      devicesRegistered: registered,
      devicesReused: reused,
      gatewaysConnected: connectedGateways.length,
      consolesConnected: connectedConsoles.length,
      setupMs: Math.round(setupMs),
    },
    telemetry: {
      sent: run.sent,
      expected,
      received: run.received,
      dropped: run.dropped,
      unmatched: run.unmatched,
      skipped: run.skipped,
      deliveryPct: expected ? Math.round((run.received / expected) * 1000) / 10 : 0,
      latencyMs: telemetry,
    },
    incidents: {
      created: run.incidentsCreated,
      expected: run.incidentsCreated * run.consolesConnected,
      received: run.incidentsReceived,
      dropped: run.incidentsDropped,
      latencyMs: incidents,
    },
    http: {
      getIncidents: { ...run.getIncidents.stat(), errors: run.httpErrors.getIncidents },
      getSnapshot: { ...run.getSnapshot.stat(), errors: run.httpErrors.getSnapshot },
      postIncident: { ...run.postIncident.stat(), errors: run.httpErrors.postIncident },
    },
    errors: { count: run.errorCount, samples: run.errors },
    serverMetrics,
    targets: { eventP95Ms: EVENT_P95_TARGET_MS, telemetryOk, incidentOk, pass: telemetryOk && incidentOk && run.errorCount === 0 },
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function reportMarkdown(r: LoadReport): string {
  const ms = (s: LatencyStat) => [s.count, s.p50, s.p95, s.p99, s.max].map(String);
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const verdict = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  const lines = [
    `# Load test report`,
    ``,
    `${r.startedAt} → ${r.finishedAt} · ${r.profile.url} · telemetry for ${r.durationS} s · **${verdict(r.targets.pass)}**`,
    ``,
    `## Profile`,
    ``,
    row(['Gateways', 'Devices', 'Cameras', 'UGVs', 'Consoles', 'Telemetry rate', 'Incidents / min']),
    row(['---', '---', '---', '---', '---', '---', '---']),
    row([
      `${r.setup.gatewaysConnected}/${r.profile.gateways}`,
      String(r.profile.devices),
      String(r.profile.cameras),
      String(r.profile.ugvs),
      `${r.setup.consolesConnected}/${r.profile.consoles}`,
      `every ${r.profile.rateMs} ms per device`,
      String(r.profile.incidentsPerMin),
    ]),
    ``,
    `Setup ${r.setup.setupMs} ms: ${r.setup.devicesRegistered} devices registered, ${r.setup.devicesReused} reused.`,
    ``,
    `## Latency (ms)`,
    ``,
    row(['Metric', 'Samples', 'p50', 'p95', 'p99', 'max', 'Target', 'Result']),
    row(['---', '---', '---', '---', '---', '---', '---', '---']),
    row(['Telemetry: gateway send → console shown', ...ms(r.telemetry.latencyMs), `p95 ≤ ${r.targets.eventP95Ms}`, verdict(r.targets.telemetryOk)]),
    row(['Incident: POST → console shown', ...ms(r.incidents.latencyMs), `p95 ≤ ${r.targets.eventP95Ms}`, r.profile.incidentsPerMin ? verdict(r.targets.incidentOk) : 'n/a']),
    row(['HTTP GET /incidents', ...ms(r.http.getIncidents), '—', r.http.getIncidents.errors ? `${r.http.getIncidents.errors} errors` : 'ok']),
    row(['HTTP GET /snapshot', ...ms(r.http.getSnapshot), '—', r.http.getSnapshot.errors ? `${r.http.getSnapshot.errors} errors` : 'ok']),
    row(['HTTP POST /incidents', ...ms(r.http.postIncident), '—', r.http.postIncident.errors ? `${r.http.postIncident.errors} errors` : 'ok']),
    ``,
    `## Delivery`,
    ``,
    row(['Stream', 'Sent / created', 'Deliveries expected', 'Received', 'Dropped', 'Skipped (back-pressure)', 'Unmatched']),
    row(['---', '---', '---', '---', '---', '---', '---']),
    row([
      'Telemetry',
      String(r.telemetry.sent),
      String(r.telemetry.expected),
      `${r.telemetry.received} (${r.telemetry.deliveryPct} %)`,
      String(r.telemetry.dropped),
      String(r.telemetry.skipped),
      String(r.telemetry.unmatched),
    ]),
    row(['Incidents', String(r.incidents.created), String(r.incidents.expected), String(r.incidents.received), String(r.incidents.dropped), '—', '—']),
    ``,
    `Errors: ${r.errors.count}${r.errors.samples.length ? '\n\n' + r.errors.samples.map((e) => `- ${e}`).join('\n') : ''}`,
  ];
  if (r.serverMetrics?.length) lines.push(``, `## Server metrics`, ``, '```', ...r.serverMetrics, '```');
  return lines.join('\n') + '\n';
}
