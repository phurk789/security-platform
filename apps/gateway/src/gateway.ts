// Edge Gateway: runs adapters on site and keeps one authenticated WebSocket to the server.
// Telemetry and events are dropped (not buffered) while the server link is down; adapters
// keep running, so devices keep their own safety behaviour regardless of the server.
// Each adapter's command ledger lives in `<dataDir>/ledger/` so dedupe survives a restart.
import WebSocket from 'ws';
import { GATEWAY_PROTOCOL, type GatewayToServer, type ServerToGateway, type GeoAnchor } from '@13store/shared';
import { CommandLedger, ledgerFile, type LedgerOptions } from './ledger';
import { consoleLogger, type Adapter, type AdapterContext, type Logger } from './sdk';
import { VideoPusher, type Pusher, type VideoPushOptions } from './videoPush';

/** Messages dropped because the server link was down, by type. */
export type DroppedCounts = Record<Exclude<GatewayToServer['t'], 'hello'>, number>;
const noDrops = (): DroppedCounts => ({ telemetry: 0, cmd: 0, event: 0, camera_result: 0 });

export interface GatewayOptions {
  /** ws:// or wss:// base URL of the platform server, e.g. ws://localhost:8080 */
  serverUrl: string;
  /** Gateway credential issued by the server (sent as `Authorization: Bearer <key>`). */
  key: string;
  gatewayId: string;
  adapters: Adapter[];
  /** WGS 84 anchor the adapters convert positions with; sent to the server so a mismatch with the site is caught. */
  geo?: GeoAnchor;
  log?: Logger;
  now?: () => number;
  /** Reconnect backoff. Defaults: 250 ms doubling up to 5 s. */
  backoff?: { initialMs: number; maxMs: number };
  /**
   * Directory for state that must survive a restart: one command ledger per device in
   * `<dataDir>/ledger/<deviceId>.json`. Omit to keep ledgers in memory only (tests, the embedded
   * simulator). Real vehicles need it: see docs/ADAPTER_CONTRACT.md §7.
   */
  dataDir?: string;
  /** Ledger retention tuning. Defaults suit the 10 s command TTL. */
  ledger?: Pick<LedgerOptions, 'retainMs' | 'maxEntries' | 'clockSkewMs'>;
  /** ffmpeg used to push video for devices declaring `stream.push` (default `ffmpeg` on PATH). */
  ffmpegPath?: string;
  /** Replaces the ffmpeg pusher (tests). */
  createPusher?: (o: VideoPushOptions) => Pusher;
}

export interface GatewayHandle {
  /** True while the WebSocket to the server is open. */
  readonly connected: boolean;
  /** Device ids the server accepted in its last `welcome`. */
  readonly accepted: ReadonlySet<string>;
  /** Messages dropped (never buffered) because the server link was down, since start. */
  readonly dropped: Readonly<DroppedCounts>;
  /** Snapshot for an operator screen (the Android edge app shows it). */
  status(): GatewayStatus;
  stop(): Promise<void>;
}

/** What a person at the edge needs to see: is the server reached, is each device alive, is video going out. */
export interface GatewayStatus {
  at: number;
  gatewayId: string;
  server: {
    url: string;
    connected: boolean;
    /** The server closed the link because it does not accept the gateway key. */
    refused: boolean;
    /** When the link last came up or went down. */
    since: number;
  };
  devices: {
    deviceId: string;
    kind: string;
    accepted: boolean;
    /** Why the server refused this device in its last welcome. */
    rejected?: string;
    /** Last telemetry the adapter produced (a MAVLink vehicle reports only while its heartbeat is fresh). */
    lastTelemetryAt?: number;
    video?: { status: string; detail: string; codec?: string };
  }[];
  dropped: DroppedCounts;
}

export function startGateway(opts: GatewayOptions): GatewayHandle {
  const log = opts.log ?? consoleLogger;
  const now = opts.now ?? Date.now;
  const backoff = opts.backoff ?? { initialMs: 250, maxMs: 5_000 };
  const byId = new Map(opts.adapters.map((a) => [a.declaration.deviceId, a]));
  let accepted = new Set<string>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = backoff.initialMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const dropped = noDrops(); // since start
  let outage = noDrops(); // since the link last went down
  let offlineSince = now();
  let everConnected = false;
  let linkSince = now();
  let refused = false;
  const rejected = new Map<string, string>();
  const lastTelemetry = new Map<string, number>();
  /** Video pushes by device id. They outlive server reconnects: each welcome only refreshes the credential. */
  const pushers = new Map<string, Pusher>();
  const createPusher = opts.createPusher ?? ((o: VideoPushOptions) => new VideoPusher(o));

  const updatePushes = (accepted: string[], media: { deviceId: string; publish: string }[]) => {
    for (const m of media) {
      const a = byId.get(m.deviceId);
      const source = a?.declaration.stream?.push ? a.declaration.stream.rtsp : undefined;
      if (!a || !source || !accepted.includes(m.deviceId)) {
        log.warn(`server sent a video publish address for ${m.deviceId}, which has no camera to push here; ignored`);
        continue;
      }
      const p = pushers.get(m.deviceId);
      if (p) p.setTarget(m.publish);
      else pushers.set(m.deviceId, createPusher({ deviceId: m.deviceId, source, target: m.publish, ffmpeg: opts.ffmpegPath, log, onState: (s) => a.onMediaState?.(s) }));
    }
    for (const a of opts.adapters) {
      const id = a.declaration.deviceId;
      if (!a.declaration.stream?.push) continue;
      if (!accepted.includes(id)) {
        // No longer this gateway's device: stop publishing it.
        pushers.get(id)?.stop();
        pushers.delete(id);
      } else if (!media.some((m) => m.deviceId === id)) {
        log.warn(`${id}: the server gave no video publish address (it has no media server for pushed video); video stays off`);
      }
    }
  };

  const send = (msg: GatewayToServer) => {
    if (ws?.readyState !== WebSocket.OPEN) {
      // Offline: drop, never buffer. The server judges freshness by when a sample arrives, so a
      // sample replayed after reconnect would look live. Count it so the outage is visible.
      if (msg.t !== 'hello') {
        dropped[msg.t]++;
        outage[msg.t]++;
      }
      return;
    }
    if (msg.t !== 'hello' && 'deviceId' in msg && !accepted.has(msg.deviceId)) return;
    ws.send(JSON.stringify(msg));
  };

  const reportOutage = () => {
    const lost = (Object.entries(outage) as [keyof DroppedCounts, number][]).filter(([, n]) => n > 0);
    outage = noDrops();
    if (!lost.length) return;
    const when = everConnected ? `during ${((now() - offlineSince) / 1000).toFixed(1)} s offline` : 'before the first connection';
    const line = `dropped ${when} (not buffered): ${lost.map(([t, n]) => `${n} ${t}`).join(', ')}`;
    // Lost command updates and events mean the server shows timed out / misses an event: worth a warning.
    if (lost.some(([t]) => t !== 'telemetry')) log.warn(line);
    else log.info(line);
  };

  const ctxFor = (a: Adapter): AdapterContext => {
    const deviceId = a.declaration.deviceId;
    return {
      now,
      log,
      ledger: new CommandLedger({ ...opts.ledger, file: opts.dataDir ? ledgerFile(opts.dataDir, deviceId) : undefined, deviceId, now, log }),
      telemetry: (t) => {
        lastTelemetry.set(deviceId, now());
        send({ t: 'telemetry', deviceId, ...t });
      },
      commandUpdate: (u) => {
        if (!accepted.has(deviceId)) return;
        send({ t: 'cmd', ...u, at: u.at ?? now() });
      },
      event: (e) => send({ t: 'event', deviceId, ...e, at: e.at ?? now() }),
      cameraResult: (r) => send({ t: 'camera_result', deviceId, ...r }),
    };
  };

  for (const a of opts.adapters) a.start(ctxFor(a));

  const onMessage = (raw: WebSocket.RawData) => {
    let msg: ServerToGateway;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return log.warn('ignored non-JSON message from server');
    }
    switch (msg.t) {
      case 'welcome':
        accepted = new Set(msg.accepted);
        rejected.clear();
        for (const r of msg.rejected) {
          rejected.set(r.deviceId, r.reason);
          log.warn(`server rejected ${r.deviceId}: ${r.reason}`);
        }
        log.info(`registered ${msg.accepted.length} device(s)`);
        updatePushes(msg.accepted, msg.media ?? []);
        return;
      case 'command': {
        const a = byId.get(msg.deviceId);
        if (!a || !accepted.has(msg.deviceId)) return log.warn(`command for unregistered device ${msg.deviceId} ignored`);
        a.onCommand(msg);
        return;
      }
      case 'camera': {
        const a = byId.get(msg.deviceId);
        if (!a || !accepted.has(msg.deviceId)) return log.warn(`camera request for unregistered device ${msg.deviceId} ignored`);
        const { t: _t, requestId, deviceId: _d, ...action } = msg;
        if (!a.onCamera) {
          send({ t: 'camera_result', deviceId: msg.deviceId, requestId, ok: false, confirmed: false, detail: 'This device has no camera control.' });
          return;
        }
        a.onCamera(requestId, action as Parameters<NonNullable<Adapter['onCamera']>>[1]);
        return;
      }
      case 'demo': {
        // `*` targets every adapter (used for a full demo reset).
        const targets = msg.deviceId === '*' ? opts.adapters : [byId.get(msg.deviceId)].filter((a): a is Adapter => !!a);
        for (const a of targets) a.onDemo(msg.action, msg.target);
        return;
      }
    }
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(`${opts.serverUrl.replace(/\/$/, '')}/api/v1/gateway`, {
      headers: { Authorization: `Bearer ${opts.key}` },
    });
    ws = sock;
    let opened = false;
    sock.on('open', () => {
      opened = true;
      refused = false;
      linkSince = now();
      delay = backoff.initialMs;
      accepted = new Set();
      log.info(`connected to ${opts.serverUrl} as ${opts.gatewayId}`);
      reportOutage();
      everConnected = true;
      sock.send(
        JSON.stringify({
          t: 'hello',
          protocol: GATEWAY_PROTOCOL,
          gatewayId: opts.gatewayId,
          adapters: opts.adapters.map((a) => a.declaration),
          geo: opts.geo,
        } satisfies GatewayToServer),
      );
    });
    sock.on('message', onMessage);
    sock.on('error', (err) => log.warn(`server link error: ${err.message}`));
    sock.on('close', (code) => {
      if (ws === sock) ws = null;
      accepted = new Set();
      if (stopped) return;
      // A link that was up starts an outage; a failed reconnect attempt only extends it.
      if (opened) offlineSince = linkSince = now();
      if (code === 4401 || code === 1008) {
        refused = true;
        log.error('server refused the gateway credential');
      }
      retry = setTimeout(connect, delay);
      delay = Math.min(backoff.maxMs, delay * 2);
    });
  };

  connect();

  return {
    get connected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    get accepted() {
      return accepted;
    },
    get dropped() {
      return { ...dropped };
    },
    status() {
      return {
        at: now(),
        gatewayId: opts.gatewayId,
        server: { url: opts.serverUrl, connected: ws?.readyState === WebSocket.OPEN, refused, since: linkSince },
        devices: opts.adapters.map((a) => {
          const id = a.declaration.deviceId;
          const push = pushers.get(id)?.state;
          return {
            deviceId: id,
            kind: a.declaration.kind,
            accepted: accepted.has(id),
            ...(rejected.has(id) ? { rejected: rejected.get(id) } : {}),
            ...(lastTelemetry.has(id) ? { lastTelemetryAt: lastTelemetry.get(id) } : {}),
            ...(push ? { video: { status: push.status, detail: push.detail, ...(push.codec ? { codec: push.codec } : {}) } } : {}),
          };
        }),
        dropped: { ...dropped },
      };
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      for (const p of pushers.values()) p.stop();
      pushers.clear();
      for (const a of opts.adapters) a.stop();
      const s = ws;
      ws = null;
      if (s && s.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          s.once('close', () => resolve());
          s.close();
          setTimeout(resolve, 500);
        });
      }
    },
  };
}
