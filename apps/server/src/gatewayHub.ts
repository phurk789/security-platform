// Edge gateway connections. Commands go out here; telemetry, acks and device events come in.
import { GATEWAY_PROTOCOL, type GatewayToServer, type ServerToGateway, type SrvCamera, type SrvCommand, type SrvDemo } from '@13store/shared';
import type { WebSocket } from 'ws';
import type { Accounts } from './accounts';
import type { GatewayLink, Platform } from './platform';

interface Conn {
  ws: WebSocket;
  orgId: string;
  gatewayId: string;
  devices: Set<string>;
}

export class GatewayHub implements GatewayLink {
  private byDevice = new Map<string, Conn>();
  private conns = new Set<Conn>();

  constructor(
    private p: Platform,
    private accounts: Accounts,
  ) {}

  /** Handles a new socket. `token` is the bearer key from the Authorization header. */
  accept(ws: WebSocket, token: string | undefined) {
    const auth = this.accounts.authenticate(token);
    if (!auth || auth.keyKind !== 'gateway') {
      ws.close(4401, 'gateway credential refused');
      return;
    }
    const conn: Conn = { ws, orgId: auth.actor.orgId, gatewayId: 'unknown', devices: new Set() };
    this.conns.add(conn);
    const send = (m: ServerToGateway) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

    ws.on('message', (raw) => {
      let msg: GatewayToServer;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        switch (msg.t) {
          case 'hello': {
            if (msg.protocol !== GATEWAY_PROTOCOL) {
              ws.close(4400, `protocol ${msg.protocol} not supported; expected ${GATEWAY_PROTOCOL}`);
              return;
            }
            conn.gatewayId = String(msg.gatewayId).slice(0, 64);
            const { accepted, rejected } = this.p.gatewayHello(conn.orgId, auth.actor.siteIds, conn.gatewayId, msg.adapters ?? [], msg.geo);
            for (const id of conn.devices) if (this.byDevice.get(id) === conn) this.byDevice.delete(id);
            conn.devices = new Set(accepted);
            for (const id of accepted) {
              const old = this.byDevice.get(id);
              if (old && old !== conn) old.devices.delete(id);
              this.byDevice.set(id, conn);
            }
            send({ t: 'welcome', serverTime: this.p.now(), accepted, rejected });
            return;
          }
          case 'telemetry':
            if (conn.devices.has(msg.deviceId)) this.p.telemetry(conn.orgId, msg);
            return;
          case 'cmd':
            this.p.commandUpdate(conn.orgId, msg);
            return;
          case 'event':
            if (conn.devices.has(msg.deviceId)) this.p.deviceEvent(conn.orgId, msg);
            return;
          case 'camera_result':
            if (conn.devices.has(msg.deviceId)) this.p.cameraResult(conn.orgId, msg);
            return;
        }
      } catch (e) {
        console.error('[gateway] message failed', e);
      }
    });

    ws.on('close', () => {
      this.conns.delete(conn);
      for (const id of conn.devices) if (this.byDevice.get(id) === conn) this.byDevice.delete(id);
      try {
        if (conn.gatewayId !== 'unknown') this.p.gatewayClosed(conn.orgId, conn.gatewayId);
      } catch (e) {
        // During shutdown the database may already be closed.
        console.warn('[gateway] close not recorded:', e instanceof Error ? e.message : e);
      }
    });
  }

  send(orgId: string, deviceId: string, msg: SrvCommand | SrvDemo | SrvCamera): boolean {
    const c = this.byDevice.get(deviceId);
    if (!c || c.orgId !== orgId || c.ws.readyState !== c.ws.OPEN) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Broadcast a demo action to every gateway of an org. */
  sendAll(orgId: string, msg: SrvDemo) {
    for (const c of this.conns) if (c.orgId === orgId && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  /** Connected gateways across every organisation (monitoring). */
  count() {
    return this.conns.size;
  }

  connected(orgId: string) {
    return [...this.conns].filter((c) => c.orgId === orgId).map((c) => ({ gatewayId: c.gatewayId, devices: [...c.devices] }));
  }

  closeAll() {
    for (const c of this.conns) c.ws.close(1001, 'server shutting down');
  }
}
