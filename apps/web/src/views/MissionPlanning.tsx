// Mission planning (การวางแผนภารกิจ): the site's plans as one list, one row each — missions,
// patrol schedules and saved routes. Creating a plan, or opening one, goes to its map screen: the
// site map with the route on it, and beside it the steps for that plan (vehicle, route drawn on
// the map, operator, checks, approval; a patrol's timetable; a saved route's checkpoints).
// Approvals, checks and commands use the original components, so the server's rules (two-person
// approval, route checks, operating area) apply unchanged.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarClock, Camera, Check, ChevronRight, CircleAlert, FolderOpen, Gamepad2, Hourglass, ListChecks, MapPinned, Pause, Pencil, Play, Plus, Route as RouteIcon, Search, Siren, Trash2, X } from 'lucide-react';
import { ROUTINE_TASK_TYPE, TASK_NAME_MAX, fmtDate, type AppState, type Mission, type Patrol, type Point, type RoutePoint, type SavedRoute } from '@13store/shared';
import { can, currentUser, fmtTime, userName } from '../domain/policy';
import { mapFocus } from '../domain/mapFocus';
import { ENDED, PLANNING, PLAN_GROUPS, RUNNING, STEPS, missionPurpose, planCounts, planList, routeNumbers, stepIndex, upcomingRuns, type PlanFilter, type PlanRow, type RouteNumbers } from '../domain/missionPlanning';
import { routeDraft, useRouteDraft, type DraftPurpose, type LibraryMeta } from '../domain/routeDraft';
import { savedRoutes, useSavedRoutes } from '../domain/savedRoutes';
import { useT, type T } from '../i18n';
import { useStore } from '../store';
import { Badge, CommandBadge, MissionBadge } from '../components/Badges';
import { Dialog } from '../components/Dialog';
import { LiveMission, Planner, PrepareMission, fmtEta } from '../components/IncidentPanel';
import { MainMap } from '../components/MainMap';
import { DAYS, PatrolForm, PatrolsOffline } from '../components/Patrols';
import './mission-planning.css';

/** A new mission being set up: for an alert or a routine task, maybe starting from a saved route. */
interface Creating {
  source: 'incident' | 'task';
  incidentId?: string;
  task: string;
  route?: string;
}

/** What the page shows: the plan list, or one plan on its map screen. */
type Screen =
  | { kind: 'list' }
  | { kind: 'mission'; id: string }
  | { kind: 'new-mission'; c: Creating }
  /** The draft was sent: open it once it arrives. `known`: the missions there before it. */
  | { kind: 'saving-mission'; known: Set<string> }
  | { kind: 'route'; id: string }
  | { kind: 'new-route' }
  | { kind: 'patrol'; id: string }
  | { kind: 'new-patrol'; route?: string };

type Go = (s: Screen) => void;
type Msg = { ok: boolean; text: string };

const FILTER_KEY = 'ps.mp.filter';
const FILTERS: { id: PlanFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'missions', label: 'Missions' },
  { id: 'patrols', label: 'Patrols' },
  { id: 'routes', label: 'Routes' },
];
/** Drawings that belong to this page: dropped when its map screen is left. */
const PAGE_DRAFTS: DraftPurpose[] = ['mission-new', 'mission-edit', 'library', 'patrol'];
const dropPageDraft = () => {
  const d = routeDraft.get();
  if (d && PAGE_DRAFTS.includes(d.purpose)) routeDraft.clear();
};

/** The screen open when the page was left, so coming back to the page opens it again. */
let lastScreen: Screen = { kind: 'list' };

/** Confirmed alerts with no mission yet: what a new mission can be for. */
function openIncidents(s: Pick<AppState, 'incidents' | 'missions'>) {
  return s.incidents
    .filter((i) => i.status === 'confirmed' && i.type !== ROUTINE_TASK_TYPE && !i.patrolId)
    .filter((i) => !s.missions.some((m) => m.incidentId === i.id && !ENDED.includes(m.status)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** "Route 3": the first number no saved route of the site uses (names are unique per site). */
function nextRouteName(t: T, routes: SavedRoute[]) {
  const taken = new Set(routes.map((r) => r.name.toLowerCase()));
  for (let n = routes.length + 1; ; n++) {
    const name = t('Route {n}', { n });
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function MissionPlanning() {
  const { s, session } = useStore();
  const t = useT();
  const [screen, setScreen] = useState<Screen>(() => lastScreen);
  const go: Go = (v) => {
    lastScreen = v;
    setScreen(v);
  };
  const [libMsg, setLibMsg] = useState<Msg | null>(null);
  const draft = useRouteDraft();

  // A saved route drawn on the map: keep it in the library (or back to drawing if the server refuses it).
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!draft || draft.state !== 'done' || draft.purpose !== 'library' || !session || handled.current === draft) return;
    handled.current = draft;
    const meta = (draft.meta as LibraryMeta | undefined) ?? { name: '' };
    const points = draft.points;
    routeDraft.clear();
    if (draft.cancelled) {
      // Cancel: a new route is given up, a saved one stays as it was.
      setLibMsg(null);
      if (!meta.id) go({ kind: 'list' });
      return;
    }
    const again = (text: string) => {
      setLibMsg({ ok: false, text });
      routeDraft.start({ purpose: 'library', deviceId: '', points, meta });
    };
    if (!meta.name.trim()) return again(t('Name the route first.'));
    void (async () => {
      try {
        const r = meta.id
          ? await session.api.patch<SavedRoute>(`/saved-routes/${encodeURIComponent(meta.id)}`, { name: meta.name.trim(), points })
          : await session.api.post<SavedRoute>('/saved-routes', { siteId: s.site?.id, name: meta.name.trim(), points });
        await savedRoutes.refresh(session.api, s.site?.id);
        setLibMsg({ ok: true, text: t('Saved as “{name}”.', { name: r.name }) });
        go({ kind: 'route', id: r.id });
      } catch (e) {
        again(t(e instanceof Error ? e.message : String(e)));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (screen.kind === 'list') return <PlanList go={(v) => (setLibMsg(null), go(v))} />;
  return <PlanScreen screen={screen} go={go} libMsg={libMsg} setLibMsg={setLibMsg} />;
}

// ---------------------------------------------------------------------------
// The plan list
// ---------------------------------------------------------------------------

function PlanList({ go }: { go: Go }) {
  const { s, session } = useStore();
  const t = useT();
  const me = currentUser(s);
  const library = useSavedRoutes(session?.api, s.site?.id);
  const [filter, setFilterState] = useState<PlanFilter>(() => {
    try {
      const v = localStorage.getItem(FILTER_KEY);
      return v === 'missions' || v === 'patrols' || v === 'routes' ? v : 'all';
    } catch {
      return 'all';
    }
  });
  const setFilter = (v: PlanFilter) => {
    setFilterState(v);
    try {
      localStorage.setItem(FILTER_KEY, v);
    } catch {
      /* this page only */
    }
  };
  const [query, setQuery] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [allEnded, setAllEnded] = useState(false);
  const groups = useMemo(() => planList(s, me, library, query, filter), [s.missions, s.incidents, s.users, s.patrols, library, me.id, me.role, query, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = planCounts(s, library);
  const allowed = {
    mission: can(me.role, 'mission.prepare') && !s.replay.active,
    patrol: can(me.role, 'patrol.manage') && !s.replay.active && !!session,
    route: can(me.role, 'mission.prepare') && !s.replay.active && !!session,
  };
  const canCreate = allowed.mission || allowed.patrol || allowed.route;
  const stats = {
    draft: s.missions.filter((m) => m.status === 'draft' || m.status === 'rejected').length,
    approval: s.missions.filter((m) => m.status === 'pending_approval').length,
    accept: s.missions.filter((m) => m.status === 'approved').length,
    running: s.missions.filter((m) => RUNNING.includes(m.status)).length,
  };
  const create = (kind: 'mission' | 'patrol' | 'route') => {
    setChoosing(false);
    dropPageDraft();
    if (kind === 'mission') go({ kind: 'new-mission', c: { source: openIncidents(s).length ? 'incident' : 'task', task: '' } });
    else if (kind === 'patrol') go({ kind: 'new-patrol' });
    else go({ kind: 'new-route' });
  };
  const open = (row: PlanRow) => go(row.kind === 'mission' ? { kind: 'mission', id: row.m.id } : row.kind === 'patrol' ? { kind: 'patrol', id: row.p.id } : { kind: 'route', id: row.r.id });

  return (
    <div className="mp mp-listpage">
      <header className="panel mp-head">
        <div className="mp-title">
          <span className="lg-eyebrow">MISSION PLANNING</span>
          <h1>{t('Mission planning')}</h1>
          <p>{t('{a} drafts · {b} awaiting approval · {c} ready to accept · {d} running', { a: stats.draft, b: stats.approval, c: stats.accept, d: stats.running })}</p>
        </div>
        {canCreate && (
          <button type="button" className="btn-primary mp-create" onClick={() => setChoosing(true)}>
            <Plus size={16} /> {t('New plan')}
          </button>
        )}
      </header>

      <section className="panel mp-plans" aria-label={t('Plans')}>
        <div className="mp-tools">
          <div className="seg mp-filter" role="tablist" aria-label={t('Show')}>
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                {t(f.label)} <small>{counts[f.id]}</small>
              </button>
            ))}
          </div>
          <label className="lg-search mp-search">
            <Search size={16} aria-hidden="true" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search plans…')} aria-label={t('Search plans…')} />
          </label>
        </div>
        <div className="mp-rows">
          {groups.map((g) => {
            const rows = g.key === 'ended' && !allEnded ? g.rows.slice(0, 6) : g.rows;
            return (
              <div key={g.key} className={`mp-group${g.key === 'mine' ? ' is-accent' : ''}`}>
                <div className="mp-group-h">
                  <span>{t(PLAN_GROUPS[g.key])}</span>
                  <b>{g.rows.length}</b>
                </div>
                {rows.map((row) => (
                  <PlanRowView key={`${row.kind}:${row.kind === 'mission' ? row.m.id : row.kind === 'patrol' ? row.p.id : row.r.id}`} row={row} onOpen={() => open(row)} />
                ))}
                {rows.length < g.rows.length && (
                  <button type="button" className="btn-ghost small mp-more" onClick={() => setAllEnded(true)}>
                    {t('Show all {n}', { n: g.rows.length })}
                  </button>
                )}
              </div>
            );
          })}
          {!groups.length &&
            (query ? (
              <p className="empty">{t('No plans match the search.')}</p>
            ) : filter === 'patrols' && !session ? (
              <PatrolsOffline />
            ) : filter === 'routes' && !session ? (
              <p className="empty">{t('Saved routes are kept on the platform server.')}</p>
            ) : (
              <div className="mp-empty">
                <ListChecks size={30} />
                <h3>{filter === 'missions' ? t('No missions yet.') : filter === 'patrols' ? t('No patrol schedules yet') : filter === 'routes' ? t('No saved routes yet') : t('No plans yet')}</h3>
                <p>{t('A plan is a mission, a scheduled patrol or a saved route. Create one, then draw its route on the map.')}</p>
                {canCreate && (
                  <button type="button" className="btn-secondary" onClick={() => setChoosing(true)}>
                    <Plus size={15} /> {t('New plan')}
                  </button>
                )}
              </div>
            ))}
        </div>
      </section>

      {choosing && (
        <Dialog title={t('What kind of plan?')} onClose={() => setChoosing(false)}>
          <div className="mp-kinds">
            {allowed.mission && (
              <button type="button" className="mp-kind-opt k-mission" onClick={() => create('mission')}>
                <ListChecks size={20} />
                <span>
                  <b>{t('Mission')}</b>
                  <small>{t('The vehicle drives a route once. A supervisor approves it first.')}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            )}
            {allowed.patrol && (
              <button type="button" className="mp-kind-opt k-patrol" onClick={() => create('patrol')}>
                <CalendarClock size={20} />
                <span>
                  <b>{t('Scheduled patrol')}</b>
                  <small>{t('The vehicle drives the route again on set days and times.')}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            )}
            {allowed.route && (
              <button type="button" className="mp-kind-opt k-route" onClick={() => create('route')}>
                <FolderOpen size={20} />
                <span>
                  <b>{t('Route')}</b>
                  <small>{t('Draw a route and keep it, to use for missions and patrols later.')}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

const KIND_LABEL = { mission: 'Mission', patrol: 'Patrol', route: 'Route' } as const;

function PlanRowView({ row, onOpen }: { row: PlanRow; onOpen: () => void }) {
  const { s } = useStore();
  const t = useT();
  let title: string;
  let id: string | undefined;
  let sub: React.ReactNode;
  let status: React.ReactNode;
  let extra: React.ReactNode = null;
  if (row.kind === 'mission') {
    const { m, turn } = row;
    const purpose = missionPurpose(s, m);
    const n = routeNumbers(RUNNING.includes(m.status) ? m.checkpoints.slice(m.nextCp) : m.checkpoints, s.devices[m.deviceId]);
    const total = m.checkpoints.length;
    title = purpose.title;
    id = m.id;
    sub = (
      <>
        {purpose.kind === 'task' ? t('Routine task') : purpose.kind === 'patrol' ? t('Patrol run') : m.incidentId} · {m.deviceId} · {userName(s, m.operatorId)} · {t('{n} checkpoints', { n: total })} ·{' '}
        {n.lengthM} m · {fmtEta(n.timeS)}
      </>
    );
    status = <MissionBadge status={m.status} />;
    extra = (
      <>
        {(m.status === 'executing' || m.status === 'paused') && (
          <span className="mp-progress" aria-label={t('{n} of {total} checkpoints passed', { n: m.nextCp, total })}>
            <i style={{ width: `${Math.round((100 * m.nextCp) / Math.max(1, total))}%` }} />
          </span>
        )}
        {m.interruption && (
          <small className="mp-warn">
            <CircleAlert size={12} /> {t(m.interruption.reason)}
          </small>
        )}
        {turn && (
          <small className="mp-turn">
            <ChevronRight size={12} /> {t(turn)}
          </small>
        )}
      </>
    );
  } else if (row.kind === 'patrol') {
    const { p } = row;
    title = p.name;
    id = p.id;
    sub = (
      <>
        {p.deviceId} · {userName(s, p.operatorId)} · {p.days.map((d) => t(DAYS[d])).join(' ')} · {p.times.join(', ')} · {t('{n} checkpoints', { n: p.route.length })}
        {p.autoStart ? ` · ${t('auto-start')}` : ''}
      </>
    );
    status = p.enabled ? (
      <Badge tone="cyan">{p.nextRunAt ? t('Next {date} {time}', { date: fmtDate(p.nextRunAt), time: fmtTime(p.nextRunAt) }) : t('Enabled')}</Badge>
    ) : (
      <Badge tone="grey">{t('Disabled')}</Badge>
    );
  } else {
    const { r } = row;
    const n = routeNumbers(r.points);
    title = r.name;
    sub = (
      <>
        {t('{n} checkpoints', { n: n.checkpoints })} · {n.lengthM} m · {fmtEta(n.timeS)}
        {n.captures > 0 && (
          <>
            {' '}
            · <Camera size={11} /> {n.captures}
          </>
        )}{' '}
        · {t('Updated {date}', { date: fmtDate(r.updatedAt) })}
      </>
    );
    status = <Badge tone="grey">{t('Kept for later')}</Badge>;
  }
  return (
    <button type="button" className={`mp-row k-${row.kind}`} onClick={onOpen}>
      <span className={`mp-type t-${row.kind}`}>{t(KIND_LABEL[row.kind])}</span>
      <span className="mp-row-main">
        <span className="mp-row-title">
          <b>{title}</b>
          {id && <span className="mono">{id}</span>}
        </span>
        <small>{sub}</small>
        {extra}
      </span>
      <span className="mp-row-status">{status}</span>
      <ChevronRight size={16} className="mp-row-go" aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// One plan on its map screen
// ---------------------------------------------------------------------------

function PlanScreen({ screen, go, libMsg, setLibMsg }: { screen: Exclude<Screen, { kind: 'list' }>; go: Go; libMsg: Msg | null; setLibMsg: (m: Msg | null) => void }) {
  const { s, session, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const library = useSavedRoutes(session?.api, s.site?.id);
  const draft = useRouteDraft();
  const drawing = draft?.state === 'drawing' && PAGE_DRAFTS.includes(draft.purpose) ? draft : null;
  const [patrolLoop, setPatrolLoop] = useState<Point[] | undefined>();
  const m = screen.kind === 'mission' ? s.missions.find((x) => x.id === screen.id) : undefined;
  const route = screen.kind === 'route' ? library.find((r) => r.id === screen.id) : undefined;
  const patrol = screen.kind === 'patrol' ? s.patrols.find((p) => p.id === screen.id) : undefined;
  const back = () => {
    dropPageDraft();
    setLibMsg(null);
    go({ kind: 'list' });
  };
  const newMission = (extra: Partial<Creating> = {}) => {
    dropPageDraft();
    setLibMsg(null);
    go({ kind: 'new-mission', c: { source: openIncidents(s).length ? 'incident' : 'task', task: '', ...extra } });
  };

  // The draft just sent: open it as soon as it arrives.
  useEffect(() => {
    if (screen.kind !== 'saving-mission') return;
    const fresh = s.missions.filter((x) => !screen.known.has(x.id));
    if (fresh.length) go({ kind: 'mission', id: fresh[fresh.length - 1].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.missions, screen]);

  // The map: a mission's route (through its incident), or the route or patrol being looked at.
  const selKey = m ? `${m.id}:${m.planVersion}` : '';
  useEffect(() => {
    if (!m) return;
    if (s.selectedIncidentId !== m.incidentId) dispatch({ type: 'selectIncident', id: m.incidentId });
    const d = s.devices[m.deviceId];
    mapFocus.fit([...m.checkpoints, ...(d && !d.noFix ? [d.pos] : [])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);
  // Any other plan: only its own route on the map, not the last mission's (drawn through its incident).
  useEffect(() => {
    if (screen.kind !== 'mission' && s.selectedIncidentId) dispatch({ type: 'selectIncident', id: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen.kind]);
  const previewPts: Point[] | null = drawing ? null : (route?.points ?? patrol?.route ?? (screen.kind === 'new-patrol' ? patrolLoop : undefined) ?? null);
  const previewKey = previewPts ? `${screen.kind}:${previewPts.map((p) => `${p.x},${p.y}`).join(';')}` : '';
  useEffect(() => {
    mapFocus.setPreview(previewPts);
    if (previewPts?.length) mapFocus.fit(previewPts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  useEffect(() => () => mapFocus.setPreview(null), []);

  // What the route adds up to: the one being drawn, else the plan's.
  const numbers: RouteNumbers | undefined = drawing
    ? drawing.points.length
      ? routeNumbers(drawing.points, s.devices[drawing.deviceId])
      : undefined
    : m
      ? routeNumbers(RUNNING.includes(m.status) ? m.checkpoints.slice(m.nextCp) : m.checkpoints, s.devices[m.deviceId])
      : route
        ? routeNumbers(route.points)
        : patrol
          ? routeNumbers(patrol.route, s.devices[patrol.deviceId])
          : screen.kind === 'new-patrol' && patrolLoop?.length
            ? routeNumbers(patrolLoop)
            : undefined;

  let head: React.ReactNode;
  let side: React.ReactNode;
  switch (screen.kind) {
    case 'mission':
      head = m ? <MissionTitle m={m} /> : <StageTitle eyebrow="MISSION" title={screen.id} />;
      side = m ? <MissionDetail key={m.id} m={m} /> : <Gone onBack={back} />;
      break;
    case 'new-mission':
    case 'saving-mission':
      head = <StageTitle eyebrow="NEW MISSION" title={t('New mission')} />;
      side =
        screen.kind === 'new-mission' ? (
          <NewMission c={screen.c} setC={(c) => go({ kind: 'new-mission', c })} onDone={(saved) => (saved ? go({ kind: 'saving-mission', known: new Set(s.missions.map((x) => x.id)) }) : back())} />
        ) : (
          <Saving onBack={back} />
        );
      break;
    case 'route':
      head = <StageTitle eyebrow="SAVED ROUTE" title={route?.name ?? t('Saved routes')} sub={route ? `${t('Updated {date}', { date: `${fmtDate(route.updatedAt)} ${fmtTime(route.updatedAt)}` })} · ${userName(s, route.createdBy)}` : undefined} />;
      side = route ? (
        <RouteDetail
          key={route.id}
          r={route}
          canEdit={can(me.role, 'mission.prepare') && !s.replay.active && !!session}
          msg={libMsg}
          onUse={() => newMission({ source: 'task', route: `lib:${route.id}` })}
          onPatrol={can(me.role, 'patrol.manage') && !!session && !s.replay.active ? () => (dropPageDraft(), setLibMsg(null), go({ kind: 'new-patrol', route: `lib:${route.id}` })) : undefined}
          onDeleted={back}
        />
      ) : (
        <Gone onBack={back} />
      );
      break;
    case 'new-route':
      head = <StageTitle eyebrow="NEW ROUTE" title={(draft?.purpose === 'library' && (draft.meta as LibraryMeta | undefined)?.name) || t('New route')} />;
      side = <NewRoute defaultName={nextRouteName(t, library)} msg={libMsg} onCancel={back} />;
      break;
    case 'patrol':
      head = <StageTitle eyebrow={`PATROL · ${screen.id}`} title={patrol?.name ?? screen.id} sub={patrol ? `${patrol.deviceId} · ${patrol.days.map((d) => t(DAYS[d])).join(' ')} · ${patrol.times.join(', ')}` : undefined} />;
      side = patrol ? <PatrolDetail key={patrol.id} p={patrol} onDeleted={back} /> : <Gone onBack={back} />;
      break;
    case 'new-patrol':
      head = <StageTitle eyebrow="NEW PATROL" title={t('New patrol schedule')} />;
      side = (
        <section className="panel mp-box">
          <div className="panel-head">
            <div>
              <span className="lg-eyebrow">NEW PATROL</span>
              <h2>{t('Set the route and the timetable')}</h2>
            </div>
            <button type="button" className="btn-ghost small" onClick={back} aria-label={t('Close')} title={t('Close')}>
              <X size={16} />
            </button>
          </div>
          <div className="step">
            <PatrolForm startWithRoute={screen.route} onSaved={(p) => go({ kind: 'patrol', id: p.id })} onCancel={back} onLoop={setPatrolLoop} />
          </div>
        </section>
      );
      break;
  }

  return (
    <div className="mp mp-mapscreen">
      <header className="panel mp-head mp-maphead">
        <button type="button" className="btn-ghost mp-back" onClick={back}>
          <ArrowLeft size={16} /> {t('Plan list')}
        </button>
        <div className="mp-maphead-main">
          {head}
          {(screen.kind === 'mission' || screen.kind === 'new-mission' || screen.kind === 'saving-mission') && <StepBar m={m} />}
        </div>
      </header>
      <div className="mp-body">
        <section className="mp-stage" aria-label={t('Route on the map')}>
          <div className="panel mp-map">
            <MainMap />
          </div>
          <StageStats n={numbers} left={!drawing && !!m && RUNNING.includes(m.status)} noVehicle={drawing ? !drawing.deviceId : screen.kind === 'route'} />
        </section>
        <aside className="mp-side" aria-label={t('Planning steps')}>
          {side}
        </aside>
      </div>
    </div>
  );
}

function StageTitle({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mp-stage-title">
      <span className="lg-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function MissionTitle({ m }: { m: Mission }) {
  const { s } = useStore();
  const { kind, title } = missionPurpose(s, m);
  return (
    <div className="mp-stage-title">
      <span className="lg-eyebrow">
        {kind === 'task' ? 'ROUTINE TASK' : kind === 'patrol' ? 'PATROL' : 'INCIDENT'} · {m.id} · {m.incidentId}
      </span>
      <h2>{title}</h2>
      <small>
        {m.deviceId} · {userName(s, m.operatorId)}
      </small>
    </div>
  );
}

/** Vehicle › route › checks › approval › operator accepts › running › finished. */
function StepBar({ m }: { m?: Mission }) {
  const t = useT();
  const cur = m ? stepIndex(m.status) : 0;
  const bad = m?.status === 'failed' || m?.status === 'cancelled' || m?.status === 'rejected';
  return (
    <ol className="mp-steps" aria-label={t('Planning steps')}>
      {STEPS.map((k, i) => {
        const last = i === STEPS.length - 1;
        const label = last && (m?.status === 'failed' || m?.status === 'cancelled') ? t(m.status === 'failed' ? 'Failed' : 'Cancelled') : i === 3 && m?.status === 'rejected' ? t('Rejected') : t(k);
        const state = (last && bad && m?.status !== 'rejected') || (i === 3 && m?.status === 'rejected') ? 'bad' : i < cur ? 'done' : i === cur ? 'now' : '';
        return (
          <li key={k} className={state} aria-current={state === 'now' ? 'step' : undefined}>
            {state === 'done' ? <Check size={12} aria-hidden="true" /> : state === 'bad' ? <X size={12} aria-hidden="true" /> : <span>{i + 1}</span>}
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function StageStats({ n, left, noVehicle }: { n?: RouteNumbers; left?: boolean; noVehicle?: boolean }) {
  const t = useT();
  if (!n) return <div className="panel mp-stats mp-stats-empty">{t('Distance and time show here once the route has checkpoints.')}</div>;
  return (
    <div className="panel mp-stats">
      <span>
        <MapPinned size={14} /> <b>{n.checkpoints}</b> {left ? t('checkpoints left') : t('checkpoints')}
      </span>
      <span>
        <RouteIcon size={14} /> <b>{n.lengthM}</b> m
      </span>
      <span title={t('At {v} m/s, the waits included', { v: n.speed })}>
        <Hourglass size={14} /> <b>{fmtEta(n.timeS)}</b> {noVehicle ? t('at {v} m/s', { v: n.speed }) : `· ${n.speed} m/s`}
      </span>
      {n.waitS > 0 && (
        <span>
          {t('waits')} <b>{Math.round(n.waitS)}</b> s
        </span>
      )}
      {n.captures > 0 && (
        <span>
          <Camera size={14} /> <b>{n.captures}</b> {t('capture points')}
        </span>
      )}
    </div>
  );
}

/** The plan is not there any more (deleted, or another site). */
function Gone({ onBack }: { onBack: () => void }) {
  const t = useT();
  return (
    <section className="panel mp-box mp-empty">
      <CircleAlert size={30} />
      <h3>{t('This plan is no longer here.')}</h3>
      <button type="button" className="btn-secondary" onClick={onBack}>
        <ArrowLeft size={15} /> {t('Plan list')}
      </button>
    </section>
  );
}

/** The new mission was sent: waiting for the server to send it back. */
function Saving({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setLate(true), 10_000);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <section className="panel mp-box mp-empty">
      <Hourglass size={30} />
      <h3>{t('Saving the plan…')}</h3>
      {late && (
        <>
          <p>{t('The new mission has not come back from the server yet. It shows in the plan list when it does.')}</p>
          <button type="button" className="btn-secondary" onClick={onBack}>
            <ArrowLeft size={15} /> {t('Plan list')}
          </button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

function MissionDetail({ m }: { m: Mission }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const { kind } = missionPurpose(s, m);
  const cmds = s.commands.filter((c) => c.missionId === m.id);
  return (
    <>
      <section className="panel mp-box">
        <dl className="mp-facts">
          <div>
            <dt>{t('Vehicle')}</dt>
            <dd>{m.deviceId}</dd>
          </div>
          <div>
            <dt>{t('Operator')}</dt>
            <dd>{userName(s, m.operatorId)}</dd>
          </div>
          <div>
            <dt>{t('Plan')}</dt>
            <dd>{t('v{v} · {n} checkpoints', { v: m.planVersion, n: m.checkpoints.length })}</dd>
          </div>
          <div>
            <dt>{t('Created')}</dt>
            <dd>
              {fmtDate(m.createdAt)} {fmtTime(m.createdAt)}
            </dd>
          </div>
        </dl>
        <div className="mp-links">
          {kind === 'incident' && (
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => {
                dispatch({ type: 'selectIncident', id: m.incidentId });
                dispatch({ type: 'setView', view: 'overview' });
              }}
            >
              <Siren size={14} /> {t('Open the incident')}
            </button>
          )}
          {RUNNING.includes(m.status) && (
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => {
                dispatch({ type: 'selectDevice', id: m.deviceId });
                dispatch({ type: 'setView', view: 'command' });
              }}
            >
              <Gamepad2 size={14} /> {t('Open in the Command Centre')}
            </button>
          )}
        </div>
      </section>
      <section className="panel mp-box mp-flow">{PLANNING.includes(m.status) ? <Planner m={m} /> : RUNNING.includes(m.status) ? <LiveMission m={m} /> : <MissionResult m={m} />}</section>
      {cmds.length > 0 && (
        <details className="panel mp-box mp-cmds">
          <summary>
            {t('Command history')} <small>({cmds.length})</small>
          </summary>
          <div className="mp-table">
            <table className="compact">
              <thead>
                <tr>
                  <th>{t('Command')}</th>
                  <th>{t('Issuer')}</th>
                  <th>{t('Sent')}</th>
                  <th>{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {cmds.map((c) => (
                  <tr key={c.id} title={`${c.id} · ${c.idempotencyKey}`}>
                    <td>{t(c.type)}</td>
                    <td>{s.users.some((u) => u.id === c.issuer) ? userName(s, c.issuer) : c.issuer}</td>
                    <td className="mono">{fmtTime(c.issuedAt, true)}</td>
                    <td>
                      <CommandBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}

/** A finished mission: how it ended, how long it took, how far it got and what it captured. */
function MissionResult({ m }: { m: Mission }) {
  const { s } = useStore();
  const t = useT();
  const start = s.commands
    .filter((c) => c.missionId === m.id && c.type === 'start')
    .map((c) => c.issuedAt)
    .sort((a, b) => a - b)[0];
  const later = s.timeline.filter((e) => e.incidentId === m.incidentId && (start === undefined || e.at >= start));
  const end = start !== undefined && later.length ? Math.max(...later.map((e) => e.at)) : undefined;
  const reached = m.status === 'completed' ? m.checkpoints.length : Math.min(m.nextCp, m.checkpoints.length);
  const shots = start === undefined ? 0 : s.evidence.filter((e) => e.incidentId === m.incidentId && e.kind !== 'note' && e.capturedAt >= start).length;
  const why =
    m.status === 'completed'
      ? t('Reached the final checkpoint, confirmed by the vehicle.')
      : m.interruption?.reason
        ? t(m.interruption.reason)
        : m.note
          ? t(m.note)
          : m.status === 'cancelled'
            ? t('Cancelled before it finished.')
            : t('Stopped before the final checkpoint.');
  return (
    <div className="step">
      <h4>{t('Result')}</h4>
      <p className={`mp-result r-${m.status}`}>
        {m.status === 'completed' ? <Check size={16} /> : <CircleAlert size={16} />} {why}
      </p>
      <dl className="mp-facts">
        <div>
          <dt>{t('Started')}</dt>
          <dd>{start === undefined ? '—' : fmtTime(start, true)}</dd>
        </div>
        <div>
          <dt>{t('Took')}</dt>
          <dd>{start === undefined || end === undefined ? '—' : fmtEta((end - start) / 1000)}</dd>
        </div>
        <div>
          <dt>{t('Checkpoints reached')}</dt>
          <dd>
            {reached} / {m.checkpoints.length}
          </dd>
        </div>
        <div>
          <dt>{t('Captured')}</dt>
          <dd>{shots}</dd>
        </div>
      </dl>
      <SaveRoute points={m.checkpoints} />
    </div>
  );
}

/** Keep a mission's route in the site's library. */
function SaveRoute({ points }: { points: RoutePoint[] }) {
  const { s, session } = useStore();
  const t = useT();
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  if (!session || !can(currentUser(s).role, 'mission.prepare') || s.replay.active || !points.length) return null;
  const save = async () => {
    if (!name?.trim()) return;
    try {
      await session.api.post('/saved-routes', { siteId: s.site?.id, name: name.trim(), points });
      await savedRoutes.refresh(session.api, s.site?.id);
      setMsg({ ok: true, text: t('Saved as “{name}”.', { name: name.trim() }) });
      setName(null);
    } catch (e) {
      setMsg({ ok: false, text: t(e instanceof Error ? e.message : String(e)) });
    }
  };
  return (
    <>
      {name === null ? (
        <button type="button" className="btn-secondary small" onClick={() => setName('')}>
          <FolderOpen size={14} /> {t('Keep this route in the library')}
        </button>
      ) : (
        <form
          className="row gap-s"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input autoFocus className="grow" value={name} maxLength={60} placeholder={t('Route name, e.g. Night loop')} onChange={(e) => setName(e.target.value)} aria-label={t('Route name')} />
          <button className="btn-secondary small" disabled={!name.trim()}>
            {t('Save')}
          </button>
        </form>
      )}
      {msg && <p className={msg.ok ? 'fine' : 'mp-bad'}>{msg.text}</p>}
    </>
  );
}

/** New mission: for a confirmed incident or a routine task, then the usual device, route and operator form. */
function NewMission({ c, setC, onDone }: { c: Creating; setC: (c: Creating) => void; onDone: (saved: boolean) => void }) {
  const { s } = useStore();
  const t = useT();
  const open = openIncidents(s);
  const inc = c.source === 'incident' ? open.find((i) => i.id === c.incidentId) : undefined;
  const ready = c.source === 'incident' ? !!inc : !!c.task.trim();
  return (
    <section className="panel mp-box">
      <div className="panel-head">
        <div>
          <span className="lg-eyebrow">NEW MISSION</span>
          <h2>{t('What is the mission for?')}</h2>
        </div>
        <button type="button" className="btn-ghost small" onClick={() => onDone(false)} aria-label={t('Close')} title={t('Close')}>
          <X size={16} />
        </button>
      </div>
      <div className="step">
        <div className="seg mp-source" role="group" aria-label={t('What is the mission for?')}>
          <button type="button" aria-pressed={c.source === 'task'} className={c.source === 'task' ? 'on' : ''} onClick={() => setC({ ...c, source: 'task' })}>
            <ListChecks size={14} /> {t('A routine task')}
          </button>
          <button type="button" aria-pressed={c.source === 'incident'} className={c.source === 'incident' ? 'on' : ''} onClick={() => setC({ ...c, source: 'incident' })}>
            <Siren size={14} /> {t('A confirmed incident')}
          </button>
        </div>
        {c.source === 'incident' ? (
          open.length ? (
            <ul className="mp-pick">
              {open.map((i) => (
                <li key={i.id}>
                  <button type="button" className={i.id === c.incidentId ? 'on' : ''} aria-pressed={i.id === c.incidentId} onClick={() => setC({ ...c, incidentId: i.id })}>
                    <b>
                      <span className="mono">{i.id}</span> · {i.title}
                    </b>
                    <small>
                      {i.place} · {i.zone} · {fmtTime(i.createdAt)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fine">{t('No confirmed incident is waiting for a mission. Plan a routine task instead.')}</p>
          )
        ) : (
          <label className="field">
            <span>{t('Task name')}</span>
            <input value={c.task} maxLength={TASK_NAME_MAX} placeholder={t('e.g. Check the north fence')} onChange={(e) => setC({ ...c, task: e.target.value })} autoFocus />
            <small className="fine">{t('The platform records the task like an incident, so the approval and the timeline work the same way.')}</small>
          </label>
        )}
      </div>
      {ready && <PrepareMission key={c.source === 'incident' ? inc!.id : 'task'} inc={inc} task={c.task} startOpen initialRoute={c.route} onClose={onDone} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Saved routes
// ---------------------------------------------------------------------------

/** A new saved route: drawing starts at once; the name can be changed while drawing. */
function NewRoute({ defaultName, msg, onCancel }: { defaultName: string; msg: Msg | null; onCancel: () => void }) {
  const t = useT();
  const draft = useRouteDraft();
  const mine = draft?.purpose === 'library' && !(draft.meta as LibraryMeta | undefined)?.id ? draft : null;
  const meta = (mine?.meta as LibraryMeta | undefined) ?? { name: '' };
  useEffect(() => {
    const d = routeDraft.get();
    if (d?.purpose === 'library' && !(d.meta as LibraryMeta | undefined)?.id) return;
    routeDraft.start({ purpose: 'library', deviceId: '', points: [], meta: { name: defaultName } satisfies LibraryMeta });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="panel mp-box">
      <div className="panel-head">
        <div>
          <span className="lg-eyebrow">NEW ROUTE</span>
          <h2>{t('New route')}</h2>
        </div>
        <button type="button" className="btn-ghost small" onClick={onCancel} aria-label={t('Close')} title={t('Close')}>
          <X size={16} />
        </button>
      </div>
      <div className="step">
        <label className="field">
          <span>{t('Route name')}</span>
          <input
            value={meta.name}
            maxLength={60}
            placeholder={t('Route name, e.g. Night loop')}
            disabled={mine?.state !== 'drawing'}
            onChange={(e) => routeDraft.setMeta({ ...meta, name: e.target.value } satisfies LibraryMeta)}
          />
        </label>
        <ol className="mp-howto">
          <li>{t('Click the map to add checkpoints, in the order the vehicle drives them.')}</li>
          <li>{t('Click a checkpoint to name it and set its speed, a wait, or a photo there.')}</li>
          <li>{t('Press “Save route” in the map panel.')}</li>
        </ol>
        {msg && <p className={msg.ok ? 'fine' : 'mp-bad'}>{msg.text}</p>}
      </div>
    </section>
  );
}

function RouteDetail({ r, canEdit, msg, onUse, onPatrol, onDeleted }: { r: SavedRoute; canEdit: boolean; msg: Msg | null; onUse: () => void; onPatrol?: () => void; onDeleted: () => void }) {
  const { s, session } = useStore();
  const t = useT();
  const [rename, setRename] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const draft = useRouteDraft();
  const editing = draft?.state === 'drawing' && draft.purpose === 'library' && (draft.meta as LibraryMeta | undefined)?.id === r.id;
  /** True when the server took the change. */
  const call = async (fn: () => Promise<unknown>) => {
    if (!session) return false;
    try {
      setErr(null);
      await fn();
      await savedRoutes.refresh(session.api, s.site?.id);
      return true;
    } catch (e) {
      setErr(t(e instanceof Error ? e.message : String(e)));
      return false;
    }
  };
  return (
    <>
      <section className="panel mp-box">
        <div className="panel-head">
          <div>
            <span className="lg-eyebrow">SAVED ROUTE</span>
            <h2>{t('Checkpoints')}</h2>
          </div>
        </div>
        <div className="step">
          <ol className="mp-points">
            {r.points.map((p, i) => (
              <li key={i}>
                <span className="mp-pt">{i + 1}</span>
                <span className="grow">{p.name ?? t('Checkpoint {n}', { n: i + 1 })}</span>
                {p.speed !== undefined && <small>{p.speed} m/s</small>}
                {p.holdS ? (
                  <small>
                    <Hourglass size={11} /> {p.holdS} s
                  </small>
                ) : null}
                {p.capture && <Camera size={13} aria-label={t('Capture point')} />}
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section className="panel mp-box">
        <div className="step">
          <button type="button" className="btn-primary" onClick={onUse} disabled={!can(currentUser(s).role, 'mission.prepare') || s.replay.active}>
            <ListChecks size={15} /> {t('Use for a new mission')}
          </button>
          {onPatrol && (
            <button type="button" className="btn-secondary" onClick={onPatrol}>
              <CalendarClock size={15} /> {t('Make it a scheduled patrol')}
            </button>
          )}
          {canEdit &&
            (editing ? (
              <p className="fine">{t('Change the route on the map, then press “Save route” in the map panel.')}</p>
            ) : (
              <div className="row gap-s wrap">
                <button type="button" className="btn-ghost small" onClick={() => routeDraft.start({ purpose: 'library', deviceId: '', points: r.points, meta: { id: r.id, name: r.name } satisfies LibraryMeta })}>
                  <MapPinned size={14} /> {t('Change on the map')}
                </button>
                <button type="button" className="btn-ghost small" onClick={() => setRename(r.name)}>
                  <Pencil size={14} /> {t('Rename')}
                </button>
                {confirm ? (
                  <>
                    <button
                      type="button"
                      className="btn-ghost small danger"
                      onClick={() => void call(() => session!.api.del(`/saved-routes/${encodeURIComponent(r.id)}`)).then((ok) => ok && onDeleted())}
                    >
                      <Trash2 size={14} /> {t('Delete “{name}”', { name: r.name })}
                    </button>
                    <button type="button" className="btn-ghost small" onClick={() => setConfirm(false)}>
                      {t('Keep it')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost small" onClick={() => setConfirm(true)}>
                    <Trash2 size={14} /> {t('Delete')}
                  </button>
                )}
              </div>
            ))}
          {rename !== null && (
            <form
              className="row gap-s"
              onSubmit={(e) => {
                e.preventDefault();
                if (rename.trim()) void call(() => session!.api.patch(`/saved-routes/${encodeURIComponent(r.id)}`, { name: rename.trim() })).then((ok) => ok && setRename(null));
              }}
            >
              <input autoFocus className="grow" value={rename} maxLength={60} onChange={(e) => setRename(e.target.value)} aria-label={t('Route name')} />
              <button className="btn-secondary small" disabled={!rename.trim()}>
                {t('Save')}
              </button>
            </form>
          )}
          {err && <p className="mp-bad">{err}</p>}
          {msg && !err && <p className={msg.ok ? 'fine' : 'mp-bad'}>{msg.text}</p>}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Scheduled patrols
// ---------------------------------------------------------------------------

function PatrolDetail({ p, onDeleted }: { p: Patrol; onDeleted: () => void }) {
  const { s, session } = useStore();
  const t = useT();
  const manage = can(currentUser(s).role, 'patrol.manage') && !s.replay.active && !!session;
  const [confirm, setConfirm] = useState(false);
  const runs = useMemo(() => upcomingRuns(s.patrols, Date.now(), 7), [s.patrols]);
  const days = new Map<string, typeof runs>();
  for (const r of runs) {
    const k = fmtDate(r.at);
    days.set(k, [...(days.get(k) ?? []), r]);
  }
  return (
    <>
      <section className="panel mp-box">
        <dl className="mp-facts">
          <div>
            <dt>{t('Vehicle')}</dt>
            <dd>{p.deviceId}</dd>
          </div>
          <div>
            <dt>{t('Operator')}</dt>
            <dd>{userName(s, p.operatorId)}</dd>
          </div>
          <div>
            <dt>{t('Days')}</dt>
            <dd>{p.days.map((d) => t(DAYS[d])).join(' ')}</dd>
          </div>
          <div>
            <dt>{t('Times')}</dt>
            <dd>{p.times.join(', ')}</dd>
          </div>
          <div>
            <dt>{t('Approved by')}</dt>
            <dd>{userName(s, p.createdBy)}</dd>
          </div>
          <div>
            <dt>{t('Start')}</dt>
            <dd>{p.autoStart ? t('Automatic when ready') : t('By the operator')}</dd>
          </div>
          <div>
            <dt>{t('Next run')}</dt>
            <dd>{p.enabled && p.nextRunAt ? `${fmtDate(p.nextRunAt)} ${fmtTime(p.nextRunAt)}` : t('Disabled')}</dd>
          </div>
          <div>
            <dt>{t('Last run')}</dt>
            <dd>{p.lastRunAt ? `${fmtTime(p.lastRunAt)} · ${t(p.lastOutcome ?? '—')}${p.lastMissionId ? ` (${p.lastMissionId})` : ''}` : '—'}</dd>
          </div>
        </dl>
        {manage && session && (
          <div className="mp-links">
            <button type="button" className="btn-secondary small" onClick={() => void session.runPatrol(p.id)}>
              <Play size={14} /> {t('Run now')}
            </button>
            <button type="button" className="btn-ghost small" onClick={() => void session.savePatrol({ enabled: !p.enabled }, p.id)}>
              {p.enabled ? <Pause size={14} /> : <Play size={14} />} {p.enabled ? t('Disable') : t('Enable')}
            </button>
            {confirm ? (
              <>
                <button type="button" className="btn-ghost small danger" onClick={() => void session.deletePatrol(p.id).then(onDeleted)}>
                  <Trash2 size={14} /> {t('Delete “{name}”', { name: p.name })}
                </button>
                <button type="button" className="btn-ghost small" onClick={() => setConfirm(false)}>
                  {t('Keep it')}
                </button>
              </>
            ) : (
              <button type="button" className="btn-ghost small" onClick={() => setConfirm(true)}>
                <Trash2 size={14} /> {t('Delete')}
              </button>
            )}
          </div>
        )}
      </section>
      <section className="panel mp-box">
        <div className="panel-head">
          <div>
            <span className="lg-eyebrow">NEXT 7 DAYS</span>
            <h2>{t('Upcoming runs')}</h2>
          </div>
        </div>
        <div className="step">
          {!runs.length && <p className="fine">{t('No runs in the next 7 days.')}</p>}
          {[...days.entries()].map(([day, list]) => (
            <div key={day} className="mp-day">
              <b>{day}</b>
              <ul>
                {list.map((r) => (
                  <li key={`${r.patrol.id}:${r.at}`} className={r.patrol.id === p.id ? 'is-selected' : ''}>
                    <span className="mono">{fmtTime(r.at)}</span>
                    <span className="grow">{r.patrol.name}</span>
                    <small>
                      {r.patrol.deviceId}
                      {r.patrol.autoStart ? ` · ${t('auto-start')}` : ''}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
