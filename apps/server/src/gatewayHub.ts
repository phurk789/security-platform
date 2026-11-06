// Edge gateway connections. Commands go out here; telemetry, acks and device events come in.
import { GATEWAY_PROTOCOL, type AiJob, type GatewayToServer, type ServerToGateway, type SrvCamera, type SrvCommand, type SrvDemo, type SrvDrive, type SrvVehicleControl } from '@13store/shared';
import type { WebSocket } from 'ws';
import type { Accounts } from './accounts';
import type { GatewayLink, Platform } from './platform';

interface Conn {
  /** Tells connections of the same gateway apart (a reconnect can arrive before the old close). */
  n: number;
  ws: WebSocket;
  orgId: string;
  gatewayId: string;
  devices: Set<string>;
  /** The gateway said hello as an AI box. */
  aiBox: boolean;
}

export class GatewayHub implements GatewayLink {
  private byDevice = new Map<string, Conn>();
  private conns = new Set<Conn>();
  private serial = 0;

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
    const conn: Conn = { n: ++this.serial, ws, orgId: auth.actor.orgId, gatewayId: 'unknown', devices: new Set(), aiBox: false };
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
            const { accepted, rejected, media, reads } = this.p.gatewayHello(conn.orgId, auth.actor.siteIds, conn.gatewayId, msg.adapters ?? [], msg.geo);
            for (const id of conn.devices) if (this.byDevice.get(id) === conn) this.byDevice.delete(id);
            conn.devices = new Set(accepted);
            for (const id of accepted) {
              const old = this.byDevice.get(id);
              if (old && old !== conn) old.devices.delete(id);
              this.byDevice.set(id, conn);
            }
            send({ t: 'welcome', serverTime: this.p.now(), accepted, rejected, ...(media.length ? { media } : {}), ...(reads.length ? { reads } : {}) });
            // After the welcome, so the box knows the server before its jobs arrive.
            if (msg.aiBox && typeof msg.aiBox === 'object') {
              conn.aiBox = true;
              this.p.aiBoxHello(conn.orgId, conn.gatewayId, msg.aiBox, conn.n);
            }
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
            // An AI box speaks about the devices it has a job for: detections and health only.
            else if (conn.aiBox) this.p.aiBoxEvent(conn.orgId, conn.gatewayId, msg);
            return;
          case 'camera_result':
            if (conn.devices.has(msg.deviceId)) this.p.cameraResult(conn.orgId, msg);
            return;
          case 'vehicle_control_result':
            if (conn.devices.has(msg.deviceId)) this.p.vehicleControlResult(conn.orgId, msg);
            return;
          case 'tracks':
            if (conn.devices.has(msg.deviceId) || (conn.aiBox && this.p.aiJobBox(conn.orgId, msg.deviceId) === conn.gatewayId)) this.p.visionTracks(conn.orgId, msg);
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
        if (conn.aiBox) this.p.aiBoxGone(conn.orgId, conn.gatewayId, conn.n);
        if (conn.gatewayId !== 'unknown') this.p.gatewayClosed(conn.orgId, conn.gatewayId);
      } catch (e) {
        // During shutdown the database may already be closed.
        console.warn('[gateway] close not recorded:', e instanceof Error ? e.message : e);
      }
    });
  }

  send(orgId: string, deviceId: string, msg: SrvCommand | SrvDemo | SrvCamera | SrvDrive | SrvVehicleControl): boolean {
    const c = this.byDevice.get(deviceId);
    if (!c || c.orgId !== orgId || c.ws.readyState !== c.ws.OPEN) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  sendAiJobs(orgId: string, gatewayId: string, jobs: AiJob[]): boolean {
    // The newest connection of that AI box (an old one may linger until its close arrives).
    const c = [...this.conns].reverse().find((x) => x.orgId === orgId && x.gatewayId === gatewayId && x.aiBox && x.ws.readyState === x.ws.OPEN);
    if (!c) return false;
    c.ws.send(JSON.stringify({ t: 'ai_jobs', jobs } satisfies ServerToGateway));
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
