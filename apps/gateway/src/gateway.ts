// Edge Gateway: runs adapters on site and keeps one authenticated WebSocket to the server.
// Telemetry and events are dropped (not buffered) while the server link is down; adapters
// keep running, so devices keep their own safety behaviour regardless of the server.
import WebSocket from 'ws';
import { GATEWAY_PROTOCOL, type GatewayToServer, type ServerToGateway } from '@13store/shared';
import { consoleLogger, type Adapter, type AdapterContext, type Logger } from './sdk';

export interface GatewayOptions {
  /** ws:// or wss:// base URL of the platform server, e.g. ws://localhost:8080 */
  serverUrl: string;
  /** Gateway credential issued by the server (sent as `Authorization: Bearer <key>`). */
  key: string;
  gatewayId: string;
  adapters: Adapter[];
  log?: Logger;
  now?: () => number;
  /** Reconnect backoff. Defaults: 250 ms doubling up to 5 s. */
  backoff?: { initialMs: number; maxMs: number };
}

export interface GatewayHandle {
  /** True while the WebSocket to the server is open. */
  readonly connected: boolean;
  /** Device ids the server accepted in its last `welcome`. */
  readonly accepted: ReadonlySet<string>;
  stop(): Promise<void>;
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

  const send = (msg: GatewayToServer) => {
    if (ws?.readyState !== WebSocket.OPEN) return; // offline: drop, never buffer
    if (msg.t !== 'hello' && 'deviceId' in msg && !accepted.has(msg.deviceId)) return;
    ws.send(JSON.stringify(msg));
  };

  const ctxFor = (a: Adapter): AdapterContext => {
    const deviceId = a.declaration.deviceId;
    return {
      now,
      log,
      telemetry: (t) => send({ t: 'telemetry', deviceId, ...t }),
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
        for (const r of msg.rejected) log.warn(`server rejected ${r.deviceId}: ${r.reason}`);
        log.info(`registered ${msg.accepted.length} device(s)`);
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
    sock.on('open', () => {
      delay = backoff.initialMs;
      accepted = new Set();
      log.info(`connected to ${opts.serverUrl} as ${opts.gatewayId}`);
      sock.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId: opts.gatewayId, adapters: opts.adapters.map((a) => a.declaration) } satisfies GatewayToServer));
    });
    sock.on('message', onMessage);
    sock.on('error', (err) => log.warn(`server link error: ${err.message}`));
    sock.on('close', (code) => {
      if (ws === sock) ws = null;
      accepted = new Set();
      if (stopped) return;
      if (code === 4401 || code === 1008) log.error('server refused the gateway credential');
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
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
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
