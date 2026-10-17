import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { CommandType, ConsoleMessage, Role } from '@13store/shared';
import { Accounts } from './accounts';
import { listAudit, verifyAudit } from './audit';
import { createBackup, listBackups, verifyBackup } from './backup';
import type { Config } from './config';
import type { DB } from './db';
import { GatewayHub } from './gatewayHub';
import { openapi } from './openapi';
import { ApiError, Platform, type Actor, type BusMessage } from './platform';
import { DEMO_ORG, resetDemo } from './seed';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    sessionHash?: string;
  }
}

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Record<string, unknown> }>;

const PUBLIC = new Set(['/api/v1/meta', '/api/v1/auth/login', '/api/v1/openapi.json', '/api/v1/health', '/api/v1/gateway', '/api/v1/ws', '/api/v1/media/auth']);

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export async function buildApp(db: DB, cfg: Config, opts: { logger?: boolean } = {}) {
  const p = new Platform(db, cfg);
  const accounts = new Accounts(db, p, cfg.sessionTtlMs);
  const hub = new GatewayHub(p, accounts);
  p.gateways = hub;

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 12 * 1024 * 1024, trustProxy: true });
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message, code: 'invalid' });
    req.log.error(err);
    console.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server.', code: 'error' });
  });

  // Security headers for every response.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/v1/') || PUBLIC.has(path) || path.startsWith('/api/v1/media/') && path.endsWith('/frame.svg')) return;
    const auth = accounts.authenticate(bearer(req));
    if (!auth) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    if (auth.actor.role === 'gateway') throw new ApiError(403, 'forbidden', 'Gateway keys can only open the gateway channel.');
    const mode = req.headers['x-console-mode'];
    req.actor = { ...auth.actor, requestId: req.id, consoleMode: mode === 'replay' ? 'replay' : 'live' };
    req.sessionHash = auth.sessionHash;
  });

  const A = (req: FastifyRequest) => req.actor!;
  const body = (req: Req) => (req.body ?? {}) as Record<string, any>;
  const num = (v: unknown, d?: number) => (v === undefined || v === '' ? d : Number(v));

  // ---- public -------------------------------------------------------------
  app.get('/api/v1/health', async () => ({ ok: true, time: p.now() }));
  app.get('/api/v1/meta', async () => p.meta(DEMO_ORG));
  app.get('/api/v1/openapi.json', async () => openapi(cfg));

  // ---- auth ---------------------------------------------------------------
  app.post('/api/v1/auth/login', async (req: Req) => {
    const b = body(req);
    if (typeof b.username !== 'string' || typeof b.password !== 'string') throw new ApiError(400, 'invalid', 'Username and password are required.');
    return accounts.login(b.username, b.password, req.ip);
  });
  app.get('/api/v1/auth/me', async (req) => {
    const auth = accounts.authenticate(bearer(req));
    return { user: auth?.user, actor: { name: A(req).name, role: A(req).role, orgId: A(req).orgId } };
  });
  app.post('/api/v1/auth/logout', async (req) => {
    if (req.sessionHash) accounts.logout(req.sessionHash, A(req));
    return { ok: true };
  });
  app.post('/api/v1/auth/step-up', async (req: Req) => {
    if (!req.sessionHash) throw new ApiError(400, 'invalid', 'Only user sessions can confirm a password.');
    return accounts.stepUp(req.sessionHash, A(req), String(body(req).password ?? ''));
  });

  // ---- sites / snapshot ----------------------------------------------------
  app.get('/api/v1/sites', async (req) => p.listSites(A(req)));
  app.get('/api/v1/sites/:id', async (req: Req) => p.site(A(req), req.params.id));
  app.get('/api/v1/snapshot', async (req: Req) => p.snapshot(A(req), req.query.siteId));
  app.get('/api/v1/users', async (req) => p.orgUsers(A(req)));

  // ---- incidents ------------------------------------------------------------
  app.get('/api/v1/incidents', async (req: Req) => {
    const q = req.query;
    return p.listIncidents(A(req), { siteId: q.siteId, status: q.status, zone: q.zone, from: num(q.from), to: num(q.to), q: q.q, deviceId: q.deviceId, limit: num(q.limit) });
  });
  app.post('/api/v1/incidents', async (req: Req) => p.createIncident(A(req), body(req) as any));
  app.post('/api/v1/alerts', async (req: Req) => {
    const a = A(req);
    if (a.role !== 'integration') throw new ApiError(403, 'forbidden', 'Alerts are sent with an integration API key.');
    const b = body(req);
    return p.createIncident({ ...a, name: String(b.source ?? a.name).slice(0, 80) }, { ...(b as any), source: String(b.source ?? a.name).slice(0, 80) });
  });
  app.get('/api/v1/incidents/:id', async (req: Req) => p.getIncident(A(req), req.params.id));
  app.patch('/api/v1/incidents/:id', async (req: Req) => p.editIncident(A(req), req.params.id, body(req)));
  app.post('/api/v1/incidents/:id/triage', async (req: Req) => p.triage(A(req), req.params.id));
  app.post('/api/v1/incidents/:id/confirm', async (req: Req) => p.confirm(A(req), req.params.id));
  app.post('/api/v1/incidents/:id/dismiss', async (req: Req) => p.dismiss(A(req), req.params.id, String(body(req).reason ?? '')));
  app.post('/api/v1/incidents/:id/merge', async (req: Req) => p.merge(A(req), req.params.id, String(body(req).intoId ?? ''), String(body(req).reason ?? '')));
  app.post('/api/v1/incidents/:id/resolve', async (req: Req) => p.resolve(A(req), req.params.id, String(body(req).outcome ?? '')));
  app.post('/api/v1/incidents/:id/close', async (req: Req) => p.close(A(req), req.params.id));
  app.post('/api/v1/incidents/:id/reopen', async (req: Req) => p.reopen(A(req), req.params.id, String(body(req).reason ?? '')));
  app.get('/api/v1/incidents/:id/timeline', async (req: Req) => {
    p.getIncident(A(req), req.params.id);
    return p.snapshot(A(req)).timeline.filter((e) => e.incidentId === req.params.id);
  });
  app.get('/api/v1/incidents/:id/evidence', async (req: Req) => p.listEvidence(A(req), req.params.id));
  app.post('/api/v1/incidents/:id/evidence', async (req: Req) => p.addEvidence(A(req), req.params.id, body(req)));
  app.get('/api/v1/incidents/:id/report', async (req: Req, reply: FastifyReply) => {
    const download = req.query.download === '1';
    const r = p.report(A(req), req.params.id, download);
    if (req.query.format === 'json') return r;
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    if (download) reply.header('Content-Disposition', `attachment; filename="${req.params.id}-report.md"`);
    return r.markdown;
  });
  app.post('/api/v1/incidents/:id/assignments', async (req: Req) => p.assign(A(req), req.params.id, String(body(req).responderId ?? '')));

  // ---- field ----------------------------------------------------------------
  app.get('/api/v1/assignments', async (req) => p.listAssignments(A(req)));
  for (const action of ['accept', 'arrive', 'report'] as const) {
    app.post(`/api/v1/assignments/:id/${action}`, async (req: Req) => p.updateAssignment(A(req), req.params.id, action, body(req)));
  }

  // ---- missions & commands ----------------------------------------------------
  app.get('/api/v1/missions', async (req) => p.snapshot(A(req)).missions);
  app.post('/api/v1/missions', async (req: Req) => p.createMission(A(req), body(req) as any));
  app.get('/api/v1/missions/:id', async (req: Req) => p.getMission(A(req), req.params.id).m);
  app.get('/api/v1/missions/:id/checks', async (req: Req) => p.checks(A(req), req.params.id));
  app.patch('/api/v1/missions/:id/route', async (req: Req) => p.editRoute(A(req), req.params.id, body(req).checkpoints));
  app.post('/api/v1/missions/:id/submit', async (req: Req) => p.submitMission(A(req), req.params.id));
  app.post('/api/v1/missions/:id/approve', async (req: Req) => p.approveMission(A(req), req.params.id));
  app.post('/api/v1/missions/:id/reject', async (req: Req) => p.rejectMission(A(req), req.params.id, String(body(req).reason ?? '')));
  app.post('/api/v1/missions/:id/cancel', async (req: Req) => p.cancelMission(A(req), req.params.id));
  app.post('/api/v1/missions/:id/accept', async (req: Req) => p.acceptMission(A(req), req.params.id));
  app.get('/api/v1/commands', async (req: Req) => p.listCommands(A(req), req.query.missionId));
  app.post('/api/v1/commands', async (req: Req) => {
    const b = body(req);
    return p.issueCommand(A(req), String(b.missionId ?? ''), b.type as CommandType, String(b.idempotencyKey ?? ''));
  });

  // ---- devices & media ----------------------------------------------------------
  app.get('/api/v1/devices', async (req: Req) => p.listDevices(A(req), req.query.siteId));
  app.get('/api/v1/devices/:id', async (req: Req) => {
    const { orgId: _o, siteId: _s, ...d } = p.getDevice(A(req), req.params.id);
    return d;
  });
  app.post('/api/v1/devices', async (req: Req) => p.registerDevice(A(req), body(req) as any));
  app.post('/api/v1/devices/:id/handover', async (req: Req) => p.handover(A(req), req.params.id, String(body(req).toUserId ?? '')));
  app.post('/api/v1/devices/:id/release', async (req: Req) => p.release(A(req), req.params.id));
  app.get('/api/v1/devices/:id/telemetry', async (req: Req) => p.telemetryHistory(A(req), req.params.id, num(req.query.from, p.now() - 3600_000)!, num(req.query.to, p.now())!));
  app.post('/api/v1/devices/:id/camera', async (req: Req) => p.cameraControl(A(req), req.params.id, body(req)));
  app.post('/api/v1/devices/:id/aim', async (req: Req) => p.aimCamera(A(req), req.params.id, body(req)));
  app.post('/api/v1/media/:id/session', async (req: Req) => p.mediaSession(A(req), req.params.id));
  // Site media server (MediaMTX authMethod: http) asks here before serving video. 200 = allow.
  app.post('/api/v1/media/auth', async (req: Req, reply: FastifyReply) => {
    const ok = p.mediaAuth(body(req));
    return reply.status(ok ? 200 : 401).send(ok ? { ok: true } : { error: 'Media access refused.', code: 'forbidden' });
  });
  app.get('/api/v1/media/:id/frame.svg', async (req: Req, reply: FastifyReply) => {
    const svg = p.mediaFrame(req.params.id, String(req.query.u ?? ''), Number(req.query.exp), String(req.query.sig ?? ''));
    reply.header('Content-Type', 'image/svg+xml').header('Cache-Control', 'no-store');
    return svg;
  });
  app.get('/api/v1/evidence/:id/content', async (req: Req, reply: FastifyReply) => {
    const download = req.query.download === '1';
    const { ev, bytes, intact } = p.evidenceContent(A(req), req.params.id, download);
    reply.header('Content-Type', ev.mime ?? 'application/octet-stream').header('X-Content-SHA256', ev.checksum ?? '').header('X-Integrity', intact ? 'ok' : 'mismatch').header('Cache-Control', 'no-store');
    if (download) reply.header('Content-Disposition', `attachment; filename="${ev.id}"`);
    if (ev.mime === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return reply.send(bytes);
  });

  // ---- audit ------------------------------------------------------------------
  app.get('/api/v1/audit', async (req: Req) => {
    p.require(A(req), 'audit.view', 'audit', { mutating: false });
    return listAudit(db, A(req).orgId, { limit: num(req.query.limit, 200), before: num(req.query.before) });
  });
  app.get('/api/v1/audit/verify', async (req) => {
    p.require(A(req), 'audit.view', 'audit', { mutating: false });
    return verifyAudit(db, A(req).orgId);
  });

  // ---- admin --------------------------------------------------------------------
  app.get('/api/v1/admin/users', async (req) => accounts.listUsers(A(req)));
  app.post('/api/v1/admin/users', async (req: Req) => accounts.createUser(A(req), body(req) as any));
  app.patch('/api/v1/admin/users/:id', async (req: Req) => accounts.updateUser(A(req), req.params.id, body(req)));
  app.get('/api/v1/admin/keys', async (req) => accounts.listKeys(A(req)));
  app.post('/api/v1/admin/keys', async (req: Req) => accounts.createKey(A(req), body(req) as any, cfg.env === 'pilot' ? 'pilot' : orgEnv(db, A(req).orgId)));
  app.delete('/api/v1/admin/keys/:id', async (req: Req) => {
    accounts.revokeKey(A(req), req.params.id);
    return { ok: true };
  });
  app.get('/api/v1/admin/gateways', async (req) => {
    p.require(A(req), 'admin.devices', 'gateways', { mutating: false });
    return hub.connected(A(req).orgId);
  });
  app.get('/api/v1/admin/backups', async (req) => {
    p.require(A(req), 'admin.backup', 'backups', { mutating: false });
    return listBackups(cfg.dataDir);
  });
  app.post('/api/v1/admin/backups', async (req) => {
    p.require(A(req), 'admin.backup', 'backups');
    const m = createBackup(db, cfg.dataDir, A(req).name, p.now());
    p.audit(A(req), 'admin.backup_create', m.id);
    return m;
  });
  app.post('/api/v1/admin/backups/:id/verify', async (req: Req) => {
    p.require(A(req), 'admin.backup', req.params.id, { mutating: false });
    const v = verifyBackup(cfg.dataDir, req.params.id);
    p.audit(A(req), 'admin.backup_verify', req.params.id, v.ok ? 'ok' : 'error', v.problems.join('; ') || undefined);
    return { ok: v.ok, problems: v.problems };
  });

  // ---- demo controls (demo environment only — F12) -------------------------------
  const demoOnly = (req: FastifyRequest) => {
    if (cfg.env !== 'demo') throw new ApiError(404, 'not_found', 'Demo controls are not available in this environment.');
    p.require(A(req), 'demo.control', 'demo');
  };
  app.post('/api/v1/demo/link', async (req: Req) => {
    demoOnly(req);
    const b = body(req);
    const d = p.getDevice(A(req), String(b.deviceId ?? ''));
    const ok = hub.send(A(req).orgId, d.id, { t: 'demo', deviceId: d.id, action: b.cut ? 'cut_link' : 'restore_link' });
    p.audit(A(req), b.cut ? 'demo.cut_link' : 'demo.restore_link', d.id, ok ? 'ok' : 'error', ok ? undefined : 'gateway not connected');
    if (!ok) throw new ApiError(409, 'conflict', 'The edge gateway for this device is not connected.');
    p.publish({ orgId: A(req).orgId, event: { type: 'notice', tone: b.cut ? 'warn' : 'info', text: `Demo: network to ${d.id} ${b.cut ? 'cut' : 'restored'}.` } });
    return { ok: true };
  });
  app.post('/api/v1/demo/inject-alert', async (req: Req) => {
    demoOnly(req);
    const a = A(req);
    const inc = p.createIncident(
      { ...a, kind: 'system', role: 'system', name: 'Gate sensor SG-2 (simulated)' },
      { title: 'Repeated gate sensor trigger', type: 'Sensor alert', severity: 'medium', zone: 'Zone B', place: 'Service gate', pos: { x: 341, y: 238 }, source: 'Gate sensor SG-2 (simulated)', cameraId: 'CCTV-02' },
    );
    p.audit(a, 'demo.inject_alert', inc.id);
    return inc;
  });
  app.post('/api/v1/demo/reset', async (req: Req) => {
    demoOnly(req);
    resetDemo(db, cfg, p.now());
    p.loadDevices();
    hub.sendAll(A(req).orgId, { t: 'demo', deviceId: '*', action: 'reset' });
    p.audit(A(req), 'demo.reset', 'scenario');
    p.publish({ orgId: A(req).orgId, event: { type: 'resync' } });
    return { ok: true };
  });

  // ---- websockets ------------------------------------------------------------------
  app.get('/api/v1/gateway', { websocket: true }, (socket, req) => hub.accept(socket, bearer(req)));

  app.get('/api/v1/ws', { websocket: true }, (socket) => {
    let actor: Actor | null = null;
    let token = '';
    const timer = setTimeout(() => !actor && socket.close(4401, 'auth timeout'), 5000);
    const onEvent = (m: BusMessage) => {
      if (actor && p.visible(actor, m) && socket.readyState === socket.OPEN) socket.send(JSON.stringify(m.event satisfies ConsoleMessage));
    };
    const recheck = setInterval(() => {
      if (actor && !accounts.authenticate(token)) socket.close(4401, 'session ended');
    }, 30_000);
    socket.on('message', (raw) => {
      if (actor) return;
      try {
        const msg = JSON.parse(String(raw)) as { type: string; token?: string };
        const auth = msg.type === 'auth' ? accounts.authenticate(msg.token) : null;
        if (!auth?.user) return socket.close(4401, 'invalid session');
        token = msg.token!;
        actor = auth.actor;
        clearTimeout(timer);
        p.bus.on('event', onEvent);
        socket.send(JSON.stringify({ type: 'hello', serverTime: p.now(), user: auth.user } satisfies ConsoleMessage));
      } catch {
        socket.close(4400, 'bad message');
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      clearInterval(recheck);
      p.bus.off('event', onEvent);
    });
  });

  // ---- static apps -------------------------------------------------------------------
  if (cfg.webDist && existsSync(cfg.webDist)) await app.register(fastifyStatic, { root: cfg.webDist, prefix: '/', decorateReply: false });
  if (cfg.fieldDist && existsSync(cfg.fieldDist)) await app.register(fastifyStatic, { root: cfg.fieldDist, prefix: '/field/', decorateReply: false });

  app.addHook('onClose', async () => {
    p.stop();
    hub.closeAll();
  });

  return { app, platform: p, accounts, hub };
}

function orgEnv(db: DB, orgId: string): 'demo' | 'sandbox' | 'pilot' {
  const r = db.prepare('SELECT env FROM orgs WHERE id = ?').get(orgId) as { env: 'demo' | 'sandbox' | 'pilot' };
  return r.env;
}

export type { Role };
