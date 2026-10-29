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
import { GOOGLE_STYLES, GoogleTiles, tileXYZ } from './googleTiles';
import { Metrics } from './metrics';
import { OidcClient, OidcError } from './oidc';
import { openapi } from './openapi';
import { EdgePairing } from './pairing';
import { EDGE_APP_MAX_BYTES, EdgeAppStore } from './edgeApp';
import { ApiError, Platform, type Actor, type BusMessage } from './platform';
import { PushService, initVapid, registerPushRoutes } from './push';
import { DEMO_ORG, resetDemo } from './seed';
import { initSecrets } from './secrets';
import { RateLimiter, safeEqual } from './security';

const APK_MIME = 'application/vnd.android.package-archive';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    sessionHash?: string;
  }
}

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Record<string, unknown> }>;

const PUBLIC = new Set([
  '/api/v1/meta',
  '/api/v1/auth/login',
  '/api/v1/auth/sso',
  '/api/v1/auth/sso/callback',
  '/api/v1/openapi.json',
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/metrics',
  '/api/v1/gateway',
  '/api/v1/ws',
  '/api/v1/media/auth',
  '/api/v1/edge/pair',
]);

function bearer(req: FastifyRequest) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export async function buildApp(db: DB, cfg: Config, opts: { logger?: boolean } = {}) {
  const secrets = initSecrets({ key: cfg.secretsKey, dataDir: cfg.dataDir });
  if (secrets.source === 'generated') console.log(`[server] generated secrets key at ${secrets.file}; keep it with the backups`);
  const p = new Platform(db, cfg);
  const accounts = new Accounts(db, p, cfg.sessionTtlMs);
  const pairing = new EdgePairing(db, p, accounts, (orgId) => (cfg.env === 'pilot' ? 'pilot' : orgEnv(db, orgId)));
  const edgeApp = new EdgeAppStore(cfg.dataDir, p);
  const hub = new GatewayHub(p, accounts);
  p.gateways = hub;
  const metrics = new Metrics();
  const vapid = initVapid(cfg);
  if (vapid.source === 'generated') console.log(`[server] generated Web Push (VAPID) keys at ${vapid.file}; keep them with the backups`);
  const push = new PushService(db, vapid, { now: () => p.now(), metrics });
  p.push = push;
  const oidc = cfg.oidc ? new OidcClient(cfg.oidc, fetch, () => p.now()) : null;
  let wsClients = 0;
  metrics.gauge('ps_devices', () => p.deviceCounts().live, { freshness: 'live' });
  metrics.gauge('ps_devices', () => p.deviceCounts().stale, { freshness: 'stale' });
  metrics.gauge('ps_devices', () => p.deviceCounts().offline, { freshness: 'offline' });
  metrics.gauge('ps_gateways_connected', () => hub.count());
  metrics.gauge('ps_console_clients', () => wsClients);
  metrics.gauge('ps_license_days_left', () => p.license.daysLeft(p.now()) ?? -1);
  p.bus.on('event', (m: BusMessage) => {
    const e = m.event as { type: string; incident?: { status: string }; command?: { status: string } };
    if (e.type === 'incident' && e.incident) metrics.inc('ps_incident_events_total', { status: e.incident.status });
    if (e.type === 'command' && e.command) metrics.inc('ps_command_events_total', { status: e.command.status });
    if (e.type === 'audit') metrics.inc('ps_audit_events_total');
  });
  p.bus.on('detection', (m: { detection: { type: string; outcome: string } }) => metrics.inc('ps_detections_total', { type: m.detection.type, outcome: m.detection.outcome }));
  p.bus.on('geofence', (m: { fence: { kind: string }; breach: boolean }) => metrics.inc('ps_geofence_events_total', { kind: m.fence.kind, breach: String(m.breach) }));
  p.bus.on('sla', (m: { stage: string }) => metrics.inc('ps_sla_breaches_total', { stage: m.stage }));
  p.bus.on('notification', (m: { delivery: { kind: string; status: string } }) => metrics.inc('ps_notifications_total', { kind: m.delivery.kind, status: m.delivery.status }));

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 12 * 1024 * 1024, trustProxy: cfg.trustProxy });
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  // Edge app updates are uploaded as the raw APK (Admin → Edge app updates).
  app.addContentTypeParser(APK_MIME, { parseAs: 'buffer', bodyLimit: EDGE_APP_MAX_BYTES }, (_req, buf, done) => done(null, buf));

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message, code: 'invalid' });
    req.log.error(err);
    console.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server.', code: 'error' });
  });

  // Request metrics (route template, not the raw URL, so ids do not explode the series).
  app.addHook('onRequest', async (req) => {
    (req as FastifyRequest & { t0?: number }).t0 = performance.now();
  });
  app.addHook('onResponse', async (req, reply) => {
    const t0 = (req as FastifyRequest & { t0?: number }).t0;
    if (t0 !== undefined) metrics.observe((performance.now() - t0) / 1000);
    metrics.inc('ps_http_requests_total', { route: req.routeOptions?.url ?? 'unmatched', method: req.method, status: reply.statusCode });
  });

  // Security headers for every response; a Content-Security-Policy for the HTML the server hosts.
  const csp = cspHeader(cfg);
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (cfg.hsts && req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const ct = String(reply.getHeader('content-type') ?? '');
    if (ct.startsWith('text/html') && !reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', csp);
  });

  // Rate limits per client address: tight on sign-in and step-up, optional on the whole API.
  const limiter = new RateLimiter();
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/v1/')) return;
    const isAuth = path === '/api/v1/auth/login' || path === '/api/v1/auth/step-up' || path.startsWith('/api/v1/auth/sso') || path === '/api/v1/edge/pair';
    const wait = isAuth ? limiter.hit(`auth:${req.ip}`, cfg.rateLimitAuthPerMin, Date.now()) : limiter.hit(`api:${req.ip}`, cfg.rateLimitPerMin, Date.now());
    if (wait) {
      metrics.inc('ps_rate_limited_total', { kind: isAuth ? 'auth' : 'api' });
      reply.header('Retry-After', String(wait));
      return reply.code(429).send({ code: 'rate_limited', message: `Too many requests. Try again in ${wait} s.` });
    }
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/v1/') || PUBLIC.has(path) || (path.startsWith('/api/v1/media/') && (path.endsWith('/frame.svg') || path.endsWith('/storyboard.svg')))) return;
    const auth = accounts.authenticate(bearer(req));
    if (!auth) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    // Gateway keys open the gateway channel, and let a paired edge app fetch its own updates.
    if (auth.actor.role === 'gateway' && !path.startsWith('/api/v1/edge/app/')) throw new ApiError(403, 'forbidden', 'Gateway keys can only open the gateway channel.');
    const mode = req.headers['x-console-mode'];
    req.actor = { ...auth.actor, requestId: req.id, consoleMode: mode === 'replay' ? 'replay' : 'live' };
    req.sessionHash = auth.sessionHash;
  });

  const A = (req: FastifyRequest) => req.actor!;
  const body = (req: Req) => (req.body ?? {}) as Record<string, any>;
  const num = (v: unknown, d?: number) => (v === undefined || v === '' ? d : Number(v));

  // ---- public -------------------------------------------------------------
  app.get('/api/v1/health', async () => ({ ok: true, time: p.now() }));
  app.get('/api/v1/ready', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
    } catch (e) {
      return reply.status(503).send({ ok: false, db: false, error: (e as Error).message });
    }
    return { ok: true, db: true, gateways: hub.count(), devices: p.deviceCounts(), license: p.license.state(p.now()), version: cfg.version };
  });
  app.get('/api/v1/metrics', async (req, reply) => {
    const token = bearer(req);
    const byToken = !!cfg.metricsToken && !!token && safeEqual(token, cfg.metricsToken);
    if (!byToken) {
      const auth = accounts.authenticate(token);
      if (!auth || auth.actor.role !== 'admin') throw new ApiError(403, 'forbidden', 'Metrics need the METRICS_TOKEN or an administrator session.');
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return metrics.render();
  });
  app.get('/api/v1/license', async (req) => p.licenseStatus(A(req).orgId));
  app.get('/api/v1/meta', async () => p.meta(DEMO_ORG));
  app.get('/api/v1/openapi.json', async () => openapi(cfg));

  // ---- auth ---------------------------------------------------------------
  app.post('/api/v1/auth/login', async (req: Req) => {
    const b = body(req);
    if (typeof b.username !== 'string' || typeof b.password !== 'string') throw new ApiError(400, 'invalid', 'Username and password are required.');
    return accounts.login(b.username, b.password, req.ip);
  });
  // Single sign-on (OpenID Connect, Authorization Code + PKCE).
  app.get('/api/v1/auth/sso', async (req: Req, reply) => {
    if (!oidc) throw new ApiError(404, 'not_found', 'Single sign-on is not configured.');
    const s = await oidc.start();
    db.prepare('DELETE FROM sso_pending WHERE created_at < ?').run(p.now() - 10 * 60_000);
    db.prepare('INSERT INTO sso_pending (state, nonce, verifier, return_to, created_at) VALUES (?,?,?,?,?)').run(
      s.state,
      s.nonce,
      s.verifier,
      typeof req.query.returnTo === 'string' ? req.query.returnTo.slice(0, 200) : null,
      p.now(),
    );
    return reply.redirect(s.url, 302);
  });
  app.get('/api/v1/auth/sso/callback', async (req: Req, reply) => {
    if (!oidc) throw new ApiError(404, 'not_found', 'Single sign-on is not configured.');
    const fail = (msg: string) => reply.redirect(`/#sso_error=${encodeURIComponent(msg)}`, 302);
    const { code, state, error, error_description } = req.query;
    if (error) return fail(String(error_description || error));
    if (!code || !state) return fail('Missing code or state.');
    const pend = db.prepare('SELECT nonce, verifier, return_to, created_at FROM sso_pending WHERE state = ?').get(state) as
      | { nonce: string; verifier: string; return_to: string | null; created_at: number }
      | undefined;
    db.prepare('DELETE FROM sso_pending WHERE state = ?').run(state);
    if (!pend || pend.created_at < p.now() - 10 * 60_000) return fail('Sign-in request expired. Try again.');
    try {
      const id = await oidc.callback(String(code), pend.nonce, pend.verifier);
      const r = accounts.loginSso(id, cfg.oidc!.orgId, cfg.oidc!.syncRole);
      // Same-origin paths only: a protocol-relative value (//evil, /\\evil) would carry the token elsewhere.
      const returnTo = pend.return_to && /^\/(?![\/\\])/.test(pend.return_to) ? pend.return_to : '/';
      return reply.redirect(`${returnTo}#sso=${encodeURIComponent(r.token)}`, 302);
    } catch (e) {
      if (e instanceof OidcError || e instanceof ApiError) return fail(e.message);
      req.log.error(e);
      return fail('Single sign-on failed.');
    }
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
  const siteParam = (req: Req) => (req.params.id === 'default' ? undefined : req.params.id);
  app.get('/api/v1/sites/:id', async (req: Req) => p.site(A(req), siteParam(req)));
  app.post('/api/v1/sites', async (req: Req) => p.createSite(A(req), body(req) as any));
  app.patch('/api/v1/sites/:id', async (req: Req) => p.renameSite(A(req), siteParam(req), body(req) as any));
  app.delete('/api/v1/sites/:id', async (req: Req) => p.deleteSite(A(req), req.params.id));
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
  // AI / sensor detections: one object or a list of up to 100, from an integration key or a signed-in dispatcher.
  app.post('/api/v1/detections', async (req: Req) => {
    const a = A(req);
    if (a.role !== 'integration' && !['dispatcher', 'supervisor', 'admin'].includes(a.role))
      throw new ApiError(403, 'forbidden', 'Detections are sent with an integration API key.');
    const b = req.body;
    const list = Array.isArray(b) ? b : [b ?? {}];
    if (list.length > 100) throw new ApiError(400, 'invalid', 'At most 100 detections per request.');
    const out = list.map((x) => p.ingestDetection({ ...a, name: String((x as { source?: string })?.source ?? a.name).slice(0, 80) }, x));
    return Array.isArray(b) ? out : out[0];
  });
  app.get('/api/v1/detections', async (req: Req) =>
    p.listDetections(A(req), {
      from: num(req.query.from),
      to: num(req.query.to),
      deviceId: req.query.deviceId || undefined,
      type: req.query.type || undefined,
      outcome: req.query.outcome || undefined,
      limit: num(req.query.limit),
    }),
  );
  app.get('/api/v1/detections/stats', async (req: Req) => p.detectionStats(A(req), num(req.query.from, p.now() - 30 * 86_400_000)!, num(req.query.to, p.now())!));
  app.get('/api/v1/incidents/:id', async (req: Req) => p.getIncident(A(req), req.params.id));
  app.get('/api/v1/incidents/:id/suggest', async (req: Req) => p.suggestUnits(A(req), req.params.id));
  app.post('/api/v1/incidents/:id/steps/:stepId', async (req: Req) => p.setStep(A(req), req.params.id, req.params.stepId, body(req).done !== false));
  // KPIs and the period report.
  app.get('/api/v1/kpi', async (req: Req) => p.kpi(A(req), num(req.query.from, p.now() - 30 * 86_400_000)!, num(req.query.to, p.now())!));
  app.get('/api/v1/kpi/report', async (req: Req, reply: FastifyReply) => {
    const download = req.query.download === '1';
    const from = num(req.query.from, p.now() - 30 * 86_400_000)!;
    const to = num(req.query.to, p.now())!;
    const r = p.kpiReport(A(req), from, to, download);
    if (!download) return r;
    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="operations-report-${new Date(from).toISOString().slice(0, 10)}.md"`);
    return r.markdown;
  });
  // Route planning and site geofences.
  app.post('/api/v1/routes/plan', async (req: Req) => p.planRouteFor(A(req), body(req) as any));
  app.get('/api/v1/geofences', async (req: Req) => p.listGeofences(A(req), req.query.siteId || undefined));
  app.post('/api/v1/geofences/import', async (req: Req) => p.importGeofences(A(req), body(req), req.query.siteId || undefined));
  // GIS: site anchor and GeoJSON.
  app.patch('/api/v1/sites/:id/geo', async (req: Req) => p.setSiteGeo(A(req), siteParam(req), body(req) as any));
  app.get('/api/v1/sites/:id/geojson', async (req: Req, reply) => {
    const download = req.query.download === '1';
    const fc = p.siteGeoJson(A(req), siteParam(req), typeof req.query.layers === 'string' ? req.query.layers.split(',') : undefined, download);
    reply.header('content-type', 'application/geo+json; charset=utf-8');
    if (download) reply.header('content-disposition', `attachment; filename="${fc.site?.id ?? 'site'}-${new Date(p.now()).toISOString().slice(0, 10)}.geojson"`);
    return JSON.stringify(fc);
  });
  app.post('/api/v1/geofences', async (req: Req) => p.saveGeofence(A(req), body(req) as any));
  app.patch('/api/v1/geofences/:id', async (req: Req) => p.saveGeofence(A(req), body(req) as any, req.params.id));
  app.delete('/api/v1/geofences/:id', async (req: Req) => p.deleteGeofence(A(req), req.params.id));
  // Scheduled patrols.
  app.get('/api/v1/patrols', async (req: Req) => p.listPatrols(A(req)).map(({ siteId: _s, ...x }) => x));
  app.post('/api/v1/patrols', async (req: Req) => p.upsertPatrol(A(req), body(req) as any));
  app.patch('/api/v1/patrols/:id', async (req: Req) => p.upsertPatrol(A(req), body(req) as any, req.params.id));
  app.delete('/api/v1/patrols/:id', async (req: Req) => p.deletePatrol(A(req), req.params.id));
  app.post('/api/v1/patrols/:id/run', async (req: Req) => p.runPatrol(A(req), req.params.id));
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
  app.post('/api/v1/incidents/:id/evidence/clip', async (req: Req) =>
    p.clipToEvidence(A(req), req.params.id, String(body(req).deviceId ?? ''), Number(body(req).start), Number(body(req).duration ?? 30)),
  );
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
  app.patch('/api/v1/devices/:id/site', async (req: Req) => p.moveDevice(A(req), req.params.id, body(req) as any));
  // Operational mode (ADR-006): promote needs a supervisor and step-up; demote a supervisor or admin.
  app.post('/api/v1/devices/:id/mode-transitions', async (req: Req) => p.transitionMode(A(req), req.params.id, body(req)));
  app.patch('/api/v1/devices/:id/integration', async (req: Req) => p.setDeviceIntegration(A(req), req.params.id, body(req)));
  app.post('/api/v1/devices/:id/service', async (req: Req) => p.recordService(A(req), req.params.id, String(body(req).note ?? '')));
  app.patch('/api/v1/devices/:id/stats', async (req: Req) => p.updateDeviceStats(A(req), req.params.id, body(req) as any));
  app.post('/api/v1/devices/:id/release', async (req: Req) => p.release(A(req), req.params.id));
  // Live driving: start / stop a drive session. Stick samples then go over the console WebSocket.
  app.post('/api/v1/devices/:id/drive', async (req: Req) => {
    const action = body(req).action;
    if (action === 'start') return p.startDriving(A(req), req.params.id);
    if (action === 'stop') return p.stopDriving(A(req), req.params.id);
    throw new ApiError(400, 'invalid', 'action must be start or stop.');
  });
  app.get('/api/v1/devices/:id/telemetry', async (req: Req) => p.telemetryHistory(A(req), req.params.id, num(req.query.from, p.now() - 3600_000)!, num(req.query.to, p.now())!));
  app.post('/api/v1/devices/:id/camera', async (req: Req) => p.cameraControl(A(req), req.params.id, body(req)));
  app.post('/api/v1/devices/:id/aim', async (req: Req) => p.aimCamera(A(req), req.params.id, body(req)));
  app.post('/api/v1/media/:id/session', async (req: Req) => p.mediaSession(A(req), req.params.id));
  app.get('/api/v1/media/:id/recordings', async (req: Req) => p.recordings(A(req), req.params.id, num(req.query.from, p.now() - 3600_000)!, num(req.query.to, p.now())!));
  app.post('/api/v1/media/:id/clip', async (req: Req) => p.clipUrl(A(req), req.params.id, Number(body(req).start), Number(body(req).duration ?? 30)));
  app.get('/api/v1/media/:id/storyboard.svg', async (req: Req, reply: FastifyReply) => {
    const svg = p.storyboard(req.params.id, Number(req.query.start), Number(req.query.duration), String(req.query.u ?? ''), Number(req.query.exp), String(req.query.sig ?? ''));
    reply.header('Content-Type', 'image/svg+xml').header('Cache-Control', 'private, max-age=60');
    return svg;
  });
  // ---- server-proxied basemaps (Google Map Tiles API; the key stays here) ----------------------
  const google = cfg.googleMapsApiKey ? new GoogleTiles(cfg.googleMapsApiKey, cfg.googleTilesUrl, { log: (m) => console.warn(m) }) : undefined;
  const googleStyle = (id: string) => {
    if (!google || !GOOGLE_STYLES[id]) throw new ApiError(404, 'not_found', `Basemap ${id} is not offered by this server.`);
    return google;
  };
  app.get('/api/v1/basemaps', async () => google?.basemaps() ?? []);
  app.get('/api/v1/basemaps/:id/tiles/:z/:x/:y', async (req: Req, reply: FastifyReply) => {
    const g = googleStyle(req.params.id);
    const t = tileXYZ(req.params.z, req.params.x, req.params.y);
    if (!t) throw new ApiError(400, 'invalid', 'Tile z/x/y out of range.');
    let r;
    try {
      r = await g.tile(req.params.id, t.z, t.x, t.y);
    } catch (e) {
      console.warn(`[google] ${req.params.id}: ${(e as Error).message}`);
      return reply.status(502).send({ error: 'The map provider did not answer.', code: 'invalid' });
    }
    if (r.status >= 400) return reply.status(r.status === 404 ? 404 : 502).header('Cache-Control', 'no-store').send();
    // Google's cache rules apply as given (no longer than they allow).
    reply.header('Content-Type', r.contentType).header('Cache-Control', r.cacheControl ?? 'private, max-age=3600');
    if (r.etag) reply.header('ETag', r.etag);
    return reply.send(r.body);
  });
  app.get('/api/v1/basemaps/:id/attribution', async (req: Req) => {
    const g = googleStyle(req.params.id);
    const n = (k: string) => Number(req.query[k]);
    const v = { zoom: Math.round(n('zoom')), north: n('north'), south: n('south'), east: n('east'), west: n('west') };
    if (!(v.zoom >= 0 && v.zoom <= 22) || !(v.north < 90 && v.south > -90 && v.north > v.south) || !(v.east <= 180 && v.west >= -180))
      throw new ApiError(400, 'invalid', 'zoom, north, south, east and west are needed.');
    try {
      return { copyright: await g.attribution(req.params.id, v) };
    } catch (e) {
      console.warn(`[google] attribution ${req.params.id}: ${(e as Error).message}`);
      return { copyright: '' };
    }
  });

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
    reply
      .header('Content-Type', ev.mime ?? 'application/octet-stream')
      .header('X-Content-SHA256', ev.checksum ?? '')
      .header('X-Integrity', intact ? 'ok' : 'mismatch')
      .header('Cache-Control', 'no-store');
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
  // One-time codes that let an edge app fetch its gateway key and configuration (E-3).
  app.get('/api/v1/admin/pairing-codes', async (req) => pairing.list(A(req)));
  app.post('/api/v1/admin/pairing-codes', async (req: Req) => pairing.create(A(req), body(req) as any));
  app.delete('/api/v1/admin/pairing-codes/:id', async (req: Req) => {
    pairing.cancel(A(req), req.params.id);
    return { ok: true };
  });
  app.post('/api/v1/edge/pair', async (req: Req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return pairing.pair(body(req) as any, { ip: req.ip, serverUrl: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.host}` });
  });
  // In-app updates of the edge app: the administrator publishes, paired apps (gateway key) fetch.
  app.get('/api/v1/admin/edge-app', async (req) => edgeApp.view(A(req)));
  app.put('/api/v1/admin/edge-app', { bodyLimit: EDGE_APP_MAX_BYTES }, async (req: Req) => edgeApp.publish(A(req), req.query, req.body));
  app.delete('/api/v1/admin/edge-app', async (req) => {
    edgeApp.unpublish(A(req));
    return { ok: true };
  });
  app.get('/api/v1/edge/app/latest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return edgeApp.forEdge(A(req));
  });
  app.get('/api/v1/edge/app/download', async (req, reply) => {
    const { release, stream } = edgeApp.download(A(req), String(req.headers['x-edge-app'] ?? ''));
    reply.header('Content-Type', APK_MIME).header('Content-Length', String(release.size)).header('X-Sha256', release.sha256).header('Cache-Control', 'no-store');
    reply.header('Content-Disposition', `attachment; filename="13store-edge-${release.versionName}.apk"`);
    return reply.send(stream);
  });
  // Edge media origins that gateway-declared stream URLs must match (per site, or the whole org).
  app.get('/api/v1/admin/edge-origins', async (req) => p.listEdgeOrigins(A(req)));
  app.put('/api/v1/admin/edge-origins', async (req: Req) => p.setEdgeOrigins(A(req), body(req)));
  app.get('/api/v1/admin/settings', async (req) => p.orgSettings(A(req)));
  app.patch('/api/v1/admin/settings', async (req: Req) => p.updateOrgSettings(A(req), body(req) as any));
  app.post('/api/v1/admin/notifications/test', async (req: Req) => p.testChannel(A(req), String(body(req).channelId ?? '')));
  app.get('/api/v1/admin/notifications/log', async (req: Req) => p.notificationLog(A(req), num(req.query.limit, 50)!));
  registerPushRoutes(app, { push, audit: (a, action, object, result, detail) => void p.audit(a, action, object, result, detail) });
  app.post('/api/v1/admin/retention/run', async (req) => {
    p.require(A(req), 'admin.settings', 'retention');
    const r = p.runPurge()[A(req).orgId];
    p.audit(A(req), 'retention.run', 'retention', 'ok', JSON.stringify(r));
    return r;
  });
  app.get('/api/v1/admin/privacy', async (req: Req) => p.privacySearch(A(req), String(req.query.q ?? '')));
  app.post('/api/v1/admin/privacy/erase', async (req: Req) => p.privacyErase(A(req), String(body(req).q ?? ''), String(body(req).reason ?? '')));
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
      {
        title: 'Repeated gate sensor trigger',
        type: 'Sensor alert',
        severity: 'medium',
        zone: 'Zone B',
        place: 'Service gate',
        pos: { x: 341, y: 238 },
        source: 'Gate sensor SG-2 (simulated)',
        cameraId: 'CCTV-02',
      },
    );
    p.audit(a, 'demo.inject_alert', inc.id);
    return inc;
  });
  // Demo: a detection as an analytics system would send it (person at the service gate, or a thermal hotspot).
  app.post('/api/v1/demo/inject-detection', async (req: Req) => {
    demoOnly(req);
    const a = A(req);
    const kind = String(body(req).type ?? 'person');
    const thermal = kind === 'thermal_hotspot';
    const frame = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${thermal ? '#1a0b2b' : '#101b2b'}"/><polygon points="0,180 120,96 200,96 320,180" fill="#2a3442"/>${
      thermal
        ? '<circle cx="214" cy="118" r="22" fill="#fb923c" opacity="0.85"/><circle cx="214" cy="118" r="10" fill="#fef08a"/>'
        : '<rect x="150" y="88" width="34" height="70" fill="none" stroke="#22d3ee" stroke-width="2"/><rect x="160" y="96" width="14" height="40" rx="6" fill="#e2e8f0"/>'
    }<text x="10" y="20" fill="#f1f5f9" font-family="sans-serif" font-size="12">CCTV-02 · ${thermal ? 'THERMAL' : 'EO'}</text><text x="310" y="20" fill="#fbbf24" font-family="sans-serif" font-size="10" text-anchor="end">SIMULATED ANALYTICS</text><text x="150" y="84" fill="#22d3ee" font-family="monospace" font-size="10">${
      thermal ? 'hotspot 78.5 °C' : 'person 0.87'
    }</text></svg>`;
    const det = p.ingestDetection(
      { ...a, kind: 'system', role: 'system', name: 'Video analytics (simulated)' },
      thermal
        ? {
            type: 'thermal_hotspot',
            confidence: 0.93,
            deviceId: 'CCTV-02',
            source: 'Thermal analytics (simulated)',
            zone: 'Zone B',
            place: 'Service gate · transformer',
            pos: { x: 352, y: 232 },
            attributes: { temperatureC: 78.5 },
            snapshot: { mime: 'image/svg+xml', base64: Buffer.from(frame).toString('base64') },
          }
        : {
            type: 'person',
            confidence: 0.87,
            deviceId: 'CCTV-02',
            source: 'Video analytics (simulated)',
            zone: 'Zone B',
            place: 'Service gate',
            pos: { x: 341, y: 238 },
            bbox: [0.47, 0.49, 0.1, 0.39],
            snapshot: { mime: 'image/svg+xml', base64: Buffer.from(frame).toString('base64') },
          },
    );
    p.audit(a, 'demo.inject_detection', det.id, 'ok', `${det.type} → ${det.outcome}${det.incidentId ? ` ${det.incidentId}` : ''}`);
    return det;
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

  app.get('/api/v1/ws', { websocket: true }, (socket, req) => {
    const origin = String(req.headers.origin ?? '');
    if (cfg.allowedOrigins.length && origin && !cfg.allowedOrigins.includes(origin)) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    let actor: Actor | null = null;
    let token = '';
    /** The site this console shows (sent with the sign-in message); other sites stay off its map. */
    let viewSite: string | undefined;
    const timer = setTimeout(() => !actor && socket.close(4401, 'auth timeout'), 5000);
    const onEvent = (m: BusMessage) => {
      if (!actor || !p.visible(actor, m) || socket.readyState !== socket.OPEN) return;
      if (viewSite && m.siteId && m.siteId !== viewSite) return;
      socket.send(JSON.stringify(m.event satisfies ConsoleMessage));
    };
    const recheck = setInterval(() => {
      if (actor && !accounts.authenticate(token)) socket.close(4401, 'session ended');
    }, 30_000);
    socket.on('message', (raw) => {
      if (actor) {
        // After sign-in the console sends only stick samples while driving (ConsoleDrive).
        try {
          const msg = JSON.parse(String(raw)) as { type?: string };
          if (msg.type === 'drive') p.drive(actor, msg as Record<string, unknown>);
        } catch {
          /* ignore malformed samples; the vehicle stops on its own when they stop */
        }
        return;
      }
      try {
        const msg = JSON.parse(String(raw)) as { type: string; token?: string; siteId?: string };
        const auth = msg.type === 'auth' ? accounts.authenticate(msg.token) : null;
        if (!auth?.user) return socket.close(4401, 'invalid session');
        token = msg.token!;
        actor = auth.actor;
        viewSite = typeof msg.siteId === 'string' && msg.siteId ? msg.siteId : undefined;
        wsClients++;
        clearTimeout(timer);
        p.bus.on('event', onEvent);
        socket.send(JSON.stringify({ type: 'hello', serverTime: p.now(), user: auth.user } satisfies ConsoleMessage));
      } catch {
        socket.close(4400, 'bad message');
      }
    });
    socket.on('close', () => {
      if (actor) {
        wsClients--;
        // A driver whose console disconnects stops driving at once.
        try {
          p.stopAllDriving(actor, 'console disconnected');
        } catch (e) {
          console.warn('[drive] stop on disconnect failed:', e instanceof Error ? e.message : e);
        }
      }
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

  return { app, platform: p, accounts, hub, metrics, push };
}

function orgEnv(db: DB, orgId: string): 'demo' | 'sandbox' | 'pilot' {
  const r = db.prepare('SELECT env FROM orgs WHERE id = ?').get(orgId) as { env: 'demo' | 'sandbox' | 'pilot' };
  return r.env;
}

export type { Role };

/** Content-Security-Policy for the hosted console and field app. Scripts only from this origin;
 *  video and WebSockets to this origin plus the configured media servers (default: any https/wss).
 *  The platform's own media server (MEDIA_PUBLIC_URL) is always allowed, also over plain http. */
export function cspHeader(cfg: Pick<Config, 'cspConnectSrc'> & Partial<Pick<Config, 'mediaPublicUrl'>>) {
  const base = cfg.cspConnectSrc.length ? cfg.cspConnectSrc : ['https:', 'wss:'];
  const remote = [...base, ...(cfg.mediaPublicUrl && !base.includes(cfg.mediaPublicUrl) ? [cfg.mediaPublicUrl] : [])].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `media-src 'self' blob: ${remote}`,
    `connect-src 'self' ${remote}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
