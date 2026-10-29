// Connected mode: mirrors server state into the same AppState the UI already renders,
// turns UI messages into API calls, and applies live WebSocket events.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  can,
  type CameraAction,
  type AppState,
  type Assignment,
  type AuditEvent,
  type Command,
  type ConsoleDrive,
  type ConsoleMessage,
  type Device,
  type Evidence,
  type Geofence,
  type Incident,
  type Meta,
  type Patrol,
  type Point,
  type Mission,
  type OperationalMode,
  type SessionUser,
  type SiteRef,
  type Snapshot,
  type TelemetrySample,
} from '@13store/shared';
import { Api, ApiError, saveBlob } from './api';
import { makeInitialState, reducer, type Msg } from './domain/reducer';
import { StoreCtx, useToastTimer, type CameraResult, type ClipLink, type MediaSession, type Recordings, type RoutePlan, type Session, type UnitSuggestion } from './store';
import { StepUpDialog } from './components/StepUp';
import { tr } from './i18n';

const LOCAL: Msg['type'][] = [
  'setView',
  'setMapMode',
  'toggleLayer',
  'selectIncident',
  'selectDevice',
  'selectBuilding',
  'setIndoor',
  'dismissToast',
  'togglePresentation',
  'seekReplay',
  'toast',
];

const DEMO_USERS = [
  { username: 'alex', name: 'Alex Chen', role: 'dispatcher' },
  { username: 'nida', name: 'Nida W.', role: 'supervisor' },
  { username: 'somchai', name: 'Somchai K.', role: 'operator' },
  { username: 'priya', name: 'Priya R.', role: 'auditor' },
  { username: 'ploy', name: 'Ploy T.', role: 'admin' },
];

function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

/** The site this user last looked at (per browser), so a reload comes back to it. */
const siteKey = (userId: string) => `ps.site.${userId}`;
function storedSite(userId: string) {
  try {
    return localStorage.getItem(siteKey(userId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function fromSnapshot(prev: AppState, snap: Snapshot, user: SessionUser, offset: number, sites?: SiteRef[]): AppState {
  // Keep the operator's selection while it still exists; never pick one for them.
  const selected = prev.selectedIncidentId && snap.incidents.some((i) => i.id === prev.selectedIncidentId) ? prev.selectedIncidentId : null;
  return {
    ...prev,
    now: Date.now() + offset,
    userId: user.id,
    users: snap.users,
    incidents: snap.incidents,
    devices: Object.fromEntries(snap.devices.map((d) => [d.id, d])),
    missions: snap.missions,
    commands: snap.commands,
    timeline: snap.timeline,
    evidence: snap.evidence,
    assignments: snap.assignments,
    geofences: snap.geofences ?? [],
    geo: snap.site?.geometry?.geo ?? prev.geo,
    site: snap.site ? { id: snap.site.id, name: snap.site.name, demo: (snap.site.geometry?.buildings?.length ?? 0) > 0 } : prev.site,
    sites: sites ?? prev.sites,
    detections: prev.detections,
    patrols: snap.patrols ?? [],
    playbooks: snap.playbooks ?? prev.playbooks,
    dataLabel: snap.meta.dataLabel,
    selectedIncidentId: selected,
  };
}

export function RemoteProvider({
  api,
  user: initialUser,
  meta,
  onLogout,
  onSwitch,
  children,
}: {
  api: Api;
  user: SessionUser;
  meta: Meta;
  onLogout: () => void;
  onSwitch?: (username: string) => Promise<void>;
  children: ReactNode;
}) {
  const user = initialUser;
  const [s, setS] = useState<AppState>(() => {
    const base = makeInitialState();
    return {
      ...base,
      userId: initialUser.id,
      users: [initialUser],
      incidents: [],
      devices: {},
      missions: [],
      commands: [],
      timeline: [],
      evidence: [],
      audit: [],
      assignments: [],
      geofences: [],
      patrols: [],
      playbooks: base.playbooks,
      telemetry: [],
      toasts: [],
      linkCut: {},
      selectedIncidentId: null,
      view: 'overview',
      dataLabel: meta.dataLabel,
    };
  });
  const offset = useRef(meta.serverTime - Date.now());
  // The site on screen. Unset: the server's default site for this user.
  const [siteId, setSiteId] = useState<string | undefined>(() => storedSite(initialUser.id));
  const siteRef = useRef(siteId);
  siteRef.current = siteId;
  const sRef = useRef(s);
  sRef.current = s;
  const [stepUp, setStepUp] = useState<null | { retry: () => void }>(null);
  const [online, setOnline] = useState(false);
  /** The live connection once signed in (stick samples go over it). */
  const wsRef = useRef<WebSocket | null>(null);

  const toast = useCallback((tone: 'info' | 'warn' | 'error' | 'ok', text: string) => setS((p) => reducer(p, { type: 'toast', tone, text })), []);

  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const reload = useCallback(async () => {
    const sites = await api.get<SiteRef[]>('/sites').catch(() => undefined);
    // A remembered site that was removed, or that this user may no longer see, falls back to the default.
    const want = siteRef.current && (!sites || sites.some((x) => x.id === siteRef.current)) ? siteRef.current : undefined;
    const snap = await api.get<Snapshot>(want ? `/snapshot?siteId=${encodeURIComponent(want)}` : '/snapshot');
    offset.current = snap.serverTime - Date.now();
    let audit: AuditEvent[] = [];
    if (can(user.role, 'audit.view')) audit = (await api.get<AuditEvent[]>('/audit?limit=300')).reverse();
    setS((p) => ({ ...fromSnapshot(p, snap, user, offset.current, sites), audit }));
  }, [api, user]);
  reloadRef.current = reload;

  // Clock.
  useEffect(() => {
    const t = window.setInterval(() => setS((p) => ({ ...p, now: Date.now() + offset.current })), 250);
    return () => window.clearInterval(t);
  }, []);

  useToastTimer(s, (m) => setS((p) => reducer(p, m)));

  // Live events.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let delay = 500;
    let timer: number | undefined;

    const apply = (m: ConsoleMessage) => {
      setS((p) => {
        switch (m.type) {
          case 'incident':
            return { ...p, incidents: upsert<Incident>(p.incidents, m.incident) };
          case 'mission':
            return { ...p, missions: upsert<Mission>(p.missions, m.mission) };
          case 'command':
            return { ...p, commands: upsert<Command>(p.commands, m.command) };
          case 'assignment':
            return { ...p, assignments: upsert<Assignment>(p.assignments, m.assignment) };
          case 'evidence':
            return { ...p, evidence: upsert<Evidence>(p.evidence, m.evidence) };
          case 'device':
            return { ...p, devices: { ...p.devices, [m.device.id]: m.device } };
          case 'geofence':
            return { ...p, geofences: m.deleted ? p.geofences.filter((g) => g.id !== m.geofence.id) : upsert<Geofence>(p.geofences, m.geofence) };
          case 'patrol':
            return { ...p, patrols: m.deleted ? p.patrols.filter((x) => x.id !== m.patrol.id) : upsert<Patrol>(p.patrols, m.patrol) };
          case 'site':
            return {
              ...p,
              geo: m.site.geometry?.geo ?? p.geo,
              site: p.site?.id === m.site.id ? { ...p.site, name: m.site.name } : p.site,
              sites: p.sites?.map((x) => (x.id === m.site.id ? { ...x, name: m.site.name } : x)),
            };
          case 'detection':
            return { ...p, detections: [m.detection, ...p.detections.filter((d) => d.id !== m.detection.id)].slice(0, 200) };
          case 'telemetry': {
            const d = p.devices[m.deviceId];
            if (!d) return p;
            const nd: Device = {
              ...d,
              pos: m.pos,
              alt: m.alt ?? d.alt,
              battery: m.battery ?? d.battery,
              speed: m.speed,
              accuracyM: m.accuracyM,
              lastSeen: m.lastSeen,
              heading: m.heading ?? d.heading,
              signal: m.signal ?? d.signal,
              latencyMs: m.latencyMs ?? d.latencyMs,
              satellites: m.satellites ?? d.satellites,
              temperatureC: m.temperatureC ?? d.temperatureC,
              gimbal: m.gimbal ?? d.gimbal,
              stats: m.stats ?? d.stats,
              noFix: m.noFix || undefined,
              components: m.components ?? d.components,
            };
            // No fix: the device is alive but its position unknown, so it adds nothing to the trail.
            if (m.noFix) return { ...p, devices: { ...p.devices, [m.deviceId]: nd } };
            const sample: TelemetrySample = {
              deviceId: m.deviceId,
              at: m.lastSeen,
              x: m.pos.x,
              y: m.pos.y,
              speed: m.speed,
              battery: m.battery,
              signal: m.signal,
              heading: m.heading,
            };
            const telemetry = d.kind === 'cctv' || p.replay.active ? p.telemetry : [...p.telemetry.slice(-3999), sample];
            return { ...p, devices: { ...p.devices, [m.deviceId]: nd }, telemetry };
          }
          case 'timeline':
            return p.timeline.some((e) => e.id === m.event.id) ? p : { ...p, timeline: [...p.timeline, m.event] };
          case 'audit':
            return p.audit.some((a) => a.id === m.audit.id) ? p : { ...p, audit: [...p.audit.slice(-999), m.audit] };
          case 'notice':
            return reducer(p, { type: 'toast', tone: m.tone, text: m.text });
          default:
            return p;
        }
      });
      if (m.type === 'resync') void reloadRef.current();
    };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
      // The site on screen goes with the sign-in, so events of other sites stay off this map.
      ws.onopen = () => ws!.send(JSON.stringify({ type: 'auth', token: api.token, siteId: siteRef.current }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as ConsoleMessage;
        if (m.type === 'hello') {
          delay = 500;
          wsRef.current = ws;
          setOnline(true);
          void reloadRef.current().catch((e) => toast('error', e.message));
          return;
        }
        apply(m);
      };
      ws.onclose = (ev) => {
        wsRef.current = null;
        if (stopped) return;
        setOnline(false);
        if (ev.code === 4401) {
          onLogout();
          return;
        }
        timer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [api, onLogout, toast, siteId]);

  const call = useCallback(
    async (fn: () => Promise<unknown>, retry: () => void, okText?: string) => {
      try {
        await fn();
        if (okText) toast('ok', okText);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'step_up_required') {
          setStepUp({ retry });
          return;
        }
        if (e instanceof ApiError && e.status === 401) {
          onLogout();
          return;
        }
        toast(e instanceof ApiError && e.status >= 500 ? 'error' : 'warn', e instanceof Error ? e.message : String(e));
      }
    },
    [toast, onLogout],
  );

  const run = useCallback(
    (msg: Msg): void => {
      if (LOCAL.includes(msg.type)) {
        setS((p) => reducer(p, msg));
        return;
      }
      const retry = () => run(msg);
      const P =
        (path: string, body: unknown = {}) =>
        () =>
          api.post(path, body);
      switch (msg.type) {
        case 'tick':
        case 'setChecksum':
          return;
        case 'setUser': {
          const u = sRef.current.users.find((x) => x.id === msg.userId);
          const demo = DEMO_USERS.find((d) => d.name === u?.name);
          if (onSwitch && demo) void onSwitch(demo.username);
          return;
        }
        case 'enterReplay': {
          api.replay = true;
          const at = Math.min(msg.at, sRef.current.now);
          setS((p) => ({ ...p, replay: { active: true, at }, telemetry: [] }));
          const movers = Object.values(sRef.current.devices).filter((d) => d.kind !== 'cctv');
          void Promise.all(
            movers.map((d) =>
              api
                .get<
                  { receivedTime: number; x: number; y: number; speed?: number; battery?: number; signal?: number; heading?: number }[]
                >(`/devices/${encodeURIComponent(d.id)}/telemetry?from=${at - 10 * 60_000}&to=${Date.now() + offset.current}`)
                .then((rows) =>
                  rows.map((r) => ({
                    deviceId: d.id,
                    at: r.receivedTime,
                    x: r.x,
                    y: r.y,
                    speed: r.speed ?? undefined,
                    battery: r.battery ?? undefined,
                    signal: r.signal ?? undefined,
                    heading: r.heading ?? undefined,
                  })),
                ),
            ),
          )
            .then((all) => setS((p) => ({ ...p, telemetry: all.flat().sort((a, b) => a.at - b.at) })))
            .catch((e) => toast('warn', tr('Could not load history: {msg}', { msg: e.message })));
          return;
        }
        case 'exitReplay':
          api.replay = false;
          setS((p) => ({ ...p, replay: { active: false, at: p.now }, telemetry: [] }));
          return;
        case 'openCamera':
          void call(P(`/incidents/${msg.incidentId}/triage`), retry);
          return;
        case 'confirmIncident':
          void call(P(`/incidents/${msg.incidentId}/confirm`), retry);
          return;
        case 'dismissIncident':
          void call(P(`/incidents/${msg.incidentId}/dismiss`, { reason: msg.reason }), retry);
          return;
        case 'mergeIncident':
          void call(P(`/incidents/${msg.incidentId}/merge`, { intoId: msg.intoId, reason: msg.reason }), retry);
          return;
        case 'resolveIncident':
          void call(P(`/incidents/${msg.incidentId}/resolve`, { outcome: msg.outcome }), retry);
          return;
        case 'closeIncident':
          void call(P(`/incidents/${msg.incidentId}/close`), retry);
          return;
        case 'reopenIncident':
          void call(P(`/incidents/${msg.incidentId}/reopen`, { reason: msg.reason }), retry);
          return;
        case 'editIncident':
          void call(() => api.patch(`/incidents/${msg.incidentId}`, { severity: msg.severity, type: msg.incidentType }), retry);
          return;
        case 'assignResponder':
          void call(P(`/incidents/${msg.incidentId}/assignments`, { responderId: msg.responderId }), retry, tr('Task sent to the field responder.'));
          return;
        case 'addNote':
          void call(P(`/incidents/${msg.incidentId}/evidence`, { text: msg.text, idempotencyKey: `note-${crypto.randomUUID?.() ?? Date.now()}` }), retry);
          return;
        case 'createMission':
          void call(P('/missions', { incidentId: msg.incidentId, deviceId: msg.deviceId, operatorId: msg.operatorId, checkpoints: msg.checkpoints }), retry);
          return;
        case 'editRoute':
          void call(() => api.patch(`/missions/${msg.missionId}/route`, { checkpoints: msg.checkpoints }), retry);
          return;
        case 'submitMission':
          void call(P(`/missions/${msg.missionId}/submit`), retry);
          return;
        case 'approveMission':
          void call(P(`/missions/${msg.missionId}/approve`), retry);
          return;
        case 'rejectMission':
          void call(P(`/missions/${msg.missionId}/reject`, { reason: msg.reason }), retry);
          return;
        case 'cancelMission':
          void call(P(`/missions/${msg.missionId}/cancel`), retry);
          return;
        case 'acceptMission':
          void call(P(`/missions/${msg.missionId}/accept`), retry);
          return;
        case 'issueCommand':
          void call(P('/commands', { missionId: msg.missionId, type: msg.command, idempotencyKey: msg.idempotencyKey }), retry);
          return;
        case 'handover':
          void call(P(`/devices/${msg.deviceId}/handover`, { toUserId: msg.toUserId }), retry);
          return;
        case 'exportReport':
          void call(
            async () => saveBlob(await api.blob(`/incidents/${msg.incidentId}/report?download=1`), `${msg.incidentId}-report.md`),
            retry,
            tr('Report for {id} exported. The download is recorded in the audit log.', { id: msg.incidentId }),
          );
          return;
        case 'demoInjectAlert':
          void call(P('/demo/inject-alert'), retry);
          return;
        case 'demoInjectDetection':
          void call(P('/demo/inject-detection', { type: msg.kind ?? 'person' }), retry);
          return;
        case 'setStep':
          void call(P(`/incidents/${encodeURIComponent(msg.incidentId)}/steps/${encodeURIComponent(msg.stepId)}`, { done: msg.done }), retry);
          return;
        case 'demoCutLink':
          void call(P('/demo/link', { deviceId: msg.deviceId, cut: true }), retry);
          setS((p) => ({ ...p, linkCut: { ...p.linkCut, [msg.deviceId]: true } }));
          return;
        case 'demoRestoreLink':
          void call(P('/demo/link', { deviceId: msg.deviceId, cut: false }), retry);
          setS((p) => ({ ...p, linkCut: { ...p.linkCut, [msg.deviceId]: false } }));
          return;
        case 'demoReset':
          void call(P('/demo/reset'), retry, tr('Demo dataset reset.'));
          setS((p) => ({ ...p, linkCut: {} }));
          return;
      }
    },
    [api, call, onSwitch, toast],
  );

  /** Runs a session action; a step-up prompt retries it, any other failure becomes a toast. */
  const guarded = useCallback(
    async <T,>(fn: () => Promise<T>, retry: () => void): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'step_up_required') setStepUp({ retry });
        else toast('warn', e instanceof Error ? e.message : String(e));
        return undefined;
      }
    },
    [toast],
  );

  const switchSite = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(siteKey(user.id), id);
      } catch {
        /* this page only */
      }
      // The live connection reconnects for the new site and reloads its snapshot.
      setS((p) => ({ ...p, selectedDeviceId: null, selectedIncidentId: null, selectedBuildingId: null }));
      setSiteId(id);
    },
    [user.id],
  );
  const refreshSites = useCallback(async () => {
    const sites = await api.get<SiteRef[]>('/sites').catch(() => undefined);
    if (sites) setS((p) => ({ ...p, sites, site: p.site && (sites.find((x) => x.id === p.site!.id) ?? p.site) }));
  }, [api]);

  const session: Session = useMemo(
    () => ({
      switchSite,
      refreshSites,
      api,
      user,
      meta,
      logout: onLogout,
      switchUser: meta.env === 'demo' ? onSwitch : undefined,
      demoUsers: meta.env === 'demo' ? DEMO_USERS : [],
      reload,
      async openEvidence(id: string, download = false) {
        try {
          const blob = await api.blob(`/evidence/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`);
          if (download) saveBlob(blob, id);
          else window.open(URL.createObjectURL(blob), '_blank', 'noopener');
        } catch (e) {
          if (e instanceof ApiError && e.code === 'step_up_required') setStepUp({ retry: () => void session.openEvidence(id, download) });
          else toast('warn', e instanceof Error ? e.message : String(e));
        }
      },
      async mediaUrl(deviceId: string) {
        const r = await api.post<{ url: string }>(`/media/${encodeURIComponent(deviceId)}/session`);
        return r.url;
      },
      mediaSession(deviceId: string) {
        return api.post<MediaSession>(`/media/${encodeURIComponent(deviceId)}/session`);
      },
      async aimCamera(deviceId: string, target: { incidentId: string } | { x: number; y: number }) {
        try {
          return await api.post<CameraResult>(`/devices/${encodeURIComponent(deviceId)}/aim`, target);
        } catch (e) {
          return { ok: false, confirmed: false, detail: e instanceof Error ? e.message : String(e) };
        }
      },
      async cameraControl(deviceId: string, action: CameraAction) {
        try {
          return await api.post<CameraResult>(`/devices/${encodeURIComponent(deviceId)}/camera`, action);
        } catch (e) {
          return { ok: false, confirmed: false, detail: e instanceof Error ? e.message : String(e) };
        }
      },
      suggestUnits(incidentId: string) {
        return api.get<UnitSuggestion[]>(`/incidents/${encodeURIComponent(incidentId)}/suggest`);
      },
      planRoute(deviceId: string, target: { incidentId: string } | Point) {
        return api.post<RoutePlan>('/routes/plan', { deviceId, ...('incidentId' in target ? { incidentId: target.incidentId } : { to: target }) });
      },
      saveGeofence: (g: Partial<Geofence>, id?: string) =>
        guarded(
          // Zones belong to the site on screen (the server looks a zone up within its site).
          () => {
            const body = { siteId: sRef.current.site?.id, ...g };
            return id ? api.patch<Geofence>(`/geofences/${encodeURIComponent(id)}`, body) : api.post<Geofence>('/geofences', body);
          },
          () => void session.saveGeofence(g, id),
        ),
      deleteGeofence: (id: string) =>
        guarded(
          () => api.del(`/geofences/${encodeURIComponent(id)}`),
          () => void session.deleteGeofence(id),
        ),
      savePatrol: (x: Partial<Patrol>, id?: string) =>
        guarded(
          () => (id ? api.patch<Patrol>(`/patrols/${encodeURIComponent(id)}`, x) : api.post<Patrol>('/patrols', x)),
          () => void session.savePatrol(x, id),
        ),
      deletePatrol: (id: string) =>
        guarded(
          () => api.del(`/patrols/${encodeURIComponent(id)}`),
          () => void session.deletePatrol(id),
        ),
      runPatrol: (id: string) =>
        guarded(
          async () => {
            const r = await api.post<{ incidentId: string; missionId: string; started: boolean }>(`/patrols/${encodeURIComponent(id)}/run`);
            toast(
              'info',
              r.started
                ? tr('Patrol started: {inc} · {msn}', { inc: r.incidentId, msn: r.missionId })
                : tr('Patrol raised: {inc} · {msn} waits for the operator to accept.', { inc: r.incidentId, msn: r.missionId }),
            );
          },
          () => void session.runPatrol(id),
        ),
      recordService: (deviceId: string, note: string) =>
        guarded(
          async () => {
            await api.post(`/devices/${encodeURIComponent(deviceId)}/service`, { note });
            toast('ok', tr('Service recorded for {id}.', { id: deviceId }));
          },
          () => void session.recordService(deviceId, note),
        ),
      moveDevice: (deviceId: string, siteId: string) =>
        guarded(
          async () => {
            await api.patch(`/devices/${encodeURIComponent(deviceId)}/site`, { siteId });
            const to = sRef.current.sites?.find((x) => x.id === siteId)?.name ?? siteId;
            toast('ok', tr('{id} moved to {site}. Pair its gateway again there.', { id: deviceId, site: to }));
            // The server also tells both sites to reload; this covers a console whose feed is reconnecting.
            await reload();
            return true;
          },
          () => void session.moveDevice(deviceId, siteId),
        ).then((ok) => ok === true),
      startDriving: (deviceId: string) =>
        guarded(
          () => api.post<Device>(`/devices/${encodeURIComponent(deviceId)}/drive`, { action: 'start' }),
          () => void session.startDriving(deviceId),
        ).then((d) => d !== undefined),
      async stopDriving(deviceId: string) {
        try {
          await api.post(`/devices/${encodeURIComponent(deviceId)}/drive`, { action: 'stop' });
        } catch (e) {
          // The server also ends the drive when this console disconnects, and the gateway stops on its own.
          toast('warn', e instanceof Error ? e.message : String(e));
        }
      },
      driveSample(deviceId: string, seq: number, throttle: number, steer: number) {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify({ type: 'drive', deviceId, seq, throttle, steer } satisfies ConsoleDrive));
        return true;
      },
      setDeviceMode: (deviceId: string, to: OperationalMode, reason: string) =>
        guarded(
          () => api.post<{ device: Device }>(`/devices/${encodeURIComponent(deviceId)}/mode-transitions`, { to, reason }),
          () => void session.setDeviceMode(deviceId, to, reason),
        ).then((d) => d !== undefined),
      recordings(deviceId: string, from: number, to: number) {
        return api.get<Recordings>(`/media/${encodeURIComponent(deviceId)}/recordings?from=${Math.round(from)}&to=${Math.round(to)}`);
      },
      clip(deviceId: string, start: number, durationS: number) {
        return api.post<ClipLink>(`/media/${encodeURIComponent(deviceId)}/clip`, { start: Math.round(start), duration: durationS });
      },
      async saveClip(incidentId: string, deviceId: string, start: number, durationS: number) {
        try {
          const ev = await api.post<{ id: string }>(`/incidents/${encodeURIComponent(incidentId)}/evidence/clip`, { deviceId, start: Math.round(start), duration: durationS });
          toast('info', tr('Clip {id} saved to the incident evidence.', { id: ev.id }));
        } catch (e) {
          if (e instanceof ApiError && e.code === 'step_up_required') setStepUp({ retry: () => void session.saveClip(incidentId, deviceId, start, durationS) });
          else toast('warn', e instanceof Error ? e.message : String(e));
        }
      },
    }),
    [api, user, meta, onLogout, onSwitch, reload, toast, guarded, switchSite, refreshSites],
  );

  return (
    <StoreCtx.Provider value={{ s: { ...s, linkCut: s.linkCut }, dispatch: run, mode: 'remote', session }}>
      {children}
      {!online && <div className="conn-banner">{tr('Reconnecting to the platform… Data on screen may be out of date.')}</div>}
      {stepUp && (
        <StepUpDialog
          api={api}
          onClose={() => setStepUp(null)}
          onDone={() => {
            const r = stepUp.retry;
            setStepUp(null);
            r();
          }}
        />
      )}
    </StoreCtx.Provider>
  );
}
