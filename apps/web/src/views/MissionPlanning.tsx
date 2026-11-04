// Mission planning (ภารกิจ): one page to plan, approve and follow missions.
// Left: the queue, with what waits on the person signed in first. Centre: where the mission is in
// its steps, the site map with its route, and what the route adds up to. Right: the planning steps
// themselves. Two more tabs swap the left and right columns for the site's route library and the
// patrol schedules; the map stays. Approvals, checks and commands use the original components, so
// the server's rules (two-person approval, route checks, operating area) apply unchanged.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Camera, Check, ChevronRight, CircleAlert, FolderOpen, Gamepad2, Hourglass, ListChecks, MapPinned, Pencil, Plus, Route as RouteIcon, Search, Siren, Trash2, X } from 'lucide-react';
import { ROUTINE_TASK_TYPE, TASK_NAME_MAX, fmtDate, type Mission, type Patrol, type RoutePoint, type SavedRoute } from '@13store/shared';
import { can, currentUser, fmtTime, userName } from '../domain/policy';
import { mapFocus } from '../domain/mapFocus';
import { ENDED, PLANNING, RUNNING, STEPS, missionPurpose, missionQueue, routeNumbers, stepIndex, upcomingRuns, type QueueItem, type RouteNumbers } from '../domain/missionPlanning';
import { routeDraft, useRouteDraft, type LibraryMeta } from '../domain/routeDraft';
import { savedRoutes, useSavedRoutes } from '../domain/savedRoutes';
import { useT } from '../i18n';
import { useStore } from '../store';
import { CommandBadge, MissionBadge } from '../components/Badges';
import { LiveMission, Planner, PrepareMission, fmtEta } from '../components/IncidentPanel';
import { MainMap } from '../components/MainMap';
import { PatrolsCard } from '../components/Patrols';
import './mission-planning.css';

type Tab = 'missions' | 'routes' | 'patrols';
const TAB_KEY = 'ps.mp.tab';

/** A new mission being set up: for an alert or a routine task, maybe starting from a saved route. */
interface Creating {
  source: 'incident' | 'task';
  incidentId?: string;
  task: string;
  route?: string;
  /** Missions that existed when it started: the new one is the first that is not among them. */
  known: Set<string>;
}

export function MissionPlanning() {
  const { s, session, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return v === 'routes' || v === 'patrols' ? v : 'missions';
    } catch {
      return 'missions';
    }
  });
  const setTab = (v: Tab) => {
    setTabState(v);
    try {
      localStorage.setItem(TAB_KEY, v);
    } catch {
      /* this page only */
    }
  };
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [justMade, setJustMade] = useState<Set<string> | null>(null);
  const [routeSel, setRouteSel] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [libMsg, setLibMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [patrolSel, setPatrolSel] = useState<string | null>(null);
  const [patrolRoute, setPatrolRoute] = useState<string | null>(null);
  const library = useSavedRoutes(session?.api, s.site?.id);
  const draft = useRouteDraft();
  const canPrepare = can(me.role, 'mission.prepare') && !s.replay.active;
  const canRoutes = canPrepare && !!session;

  const queue = useMemo(() => missionQueue(s, me, query), [s.missions, s.incidents, s.users, me.id, me.role, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const fallback = queue.mine[0] ?? queue.running[0] ?? queue.planning[0] ?? queue.ended[0];
  const sel = creating ? undefined : ((selId ? s.missions.find((m) => m.id === selId) : undefined) ?? fallback?.m);
  const route = library.find((r) => r.id === routeSel) ?? (naming === null ? library[0] : undefined);
  const patrol = s.patrols.find((p) => p.id === patrolSel) ?? s.patrols[0];

  const counts = {
    draft: s.missions.filter((m) => m.status === 'draft' || m.status === 'rejected').length,
    approval: s.missions.filter((m) => m.status === 'pending_approval').length,
    accept: s.missions.filter((m) => m.status === 'approved').length,
    running: s.missions.filter((m) => RUNNING.includes(m.status)).length,
  };

  // The draft just saved: select it as soon as it arrives.
  useEffect(() => {
    if (!justMade) return;
    const fresh = s.missions.filter((m) => !justMade.has(m.id));
    if (fresh.length) {
      setSelId(fresh[fresh.length - 1].id);
      setJustMade(null);
    }
  }, [s.missions, justMade]);

  // The map: the selected mission's route (through the selected incident), or the route being looked at.
  const selKey = tab === 'missions' && sel ? `${sel.id}:${sel.planVersion}` : '';
  useEffect(() => {
    if (!sel || tab !== 'missions') return;
    if (s.selectedIncidentId !== sel.incidentId) dispatch({ type: 'selectIncident', id: sel.incidentId });
    const d = s.devices[sel.deviceId];
    mapFocus.fit([...sel.checkpoints, ...(d && !d.noFix ? [d.pos] : [])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);
  const previewPts: RoutePoint[] | null = draft?.state === 'drawing' ? null : tab === 'routes' ? (route?.points ?? null) : tab === 'patrols' ? (patrol?.route ?? null) : null;
  const previewKey = previewPts ? `${tab}:${route?.id ?? ''}:${patrol?.id ?? ''}:${previewPts.length}` : '';
  useEffect(() => {
    mapFocus.setPreview(previewPts);
    if (previewPts?.length) mapFocus.fit(previewPts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  useEffect(() => () => mapFocus.setPreview(null), []);

  // A saved route drawn on the map: keep it in the library (or back to drawing if the server refuses it).
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (!draft || draft.state !== 'done' || draft.purpose !== 'library' || !session || handled.current === draft) return;
    handled.current = draft;
    const meta = draft.meta as LibraryMeta;
    const points = draft.points;
    routeDraft.clear();
    void (async () => {
      try {
        const r = meta.id
          ? await session.api.patch<SavedRoute>(`/saved-routes/${encodeURIComponent(meta.id)}`, { name: meta.name, points })
          : await session.api.post<SavedRoute>('/saved-routes', { siteId: s.site?.id, name: meta.name, points });
        await savedRoutes.refresh(session.api, s.site?.id);
        setRouteSel(r.id);
        setNaming(null);
        setLibMsg({ ok: true, text: t('Saved as “{name}”.', { name: meta.name }) });
      } catch (e) {
        setLibMsg({ ok: false, text: t(e instanceof Error ? e.message : String(e)) });
        routeDraft.start({ purpose: 'library', deviceId: '', points, meta });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const newMission = (extra: Partial<Creating> = {}) => {
    setTab('missions');
    setCreating({ source: 'incident', task: '', known: new Set(s.missions.map((m) => m.id)), ...extra });
  };
  const doneCreating = (saved: boolean) => {
    if (saved && creating) setJustMade(creating.known);
    setCreating(null);
  };

  return (
    <div className="mp">
      <header className="panel mp-head">
        <div className="mp-title">
          <span className="lg-eyebrow">MISSION PLANNING</span>
          <h1>{t('Mission planning')}</h1>
          <p>{t('{a} drafts · {b} awaiting approval · {c} ready to accept · {d} running', { a: counts.draft, b: counts.approval, c: counts.accept, d: counts.running })}</p>
        </div>
        <div className="seg mp-tabs" role="tablist" aria-label={t('Mission planning')}>
          <button type="button" role="tab" aria-selected={tab === 'missions'} className={tab === 'missions' ? 'on' : ''} onClick={() => setTab('missions')}>
            <ListChecks size={14} /> {t('Missions')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'routes'} className={tab === 'routes' ? 'on' : ''} onClick={() => setTab('routes')}>
            <FolderOpen size={14} /> {t('Saved routes')} <small>{library.length}</small>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'patrols'} className={tab === 'patrols' ? 'on' : ''} onClick={() => setTab('patrols')}>
            <CalendarClock size={14} /> {t('Scheduled patrols')} <small>{s.patrols.length}</small>
          </button>
        </div>
        {tab === 'missions' && canPrepare && (
          <button type="button" className="btn-primary" onClick={() => newMission()}>
            <Plus size={16} /> {t('New mission')}
          </button>
        )}
        {tab === 'routes' && canRoutes && (
          <button type="button" className="btn-primary" onClick={() => setNaming('')}>
            <Plus size={16} /> {t('New route')}
          </button>
        )}
      </header>

      <div className="mp-body">
        <aside className="panel mp-list" aria-label={t('List')}>
          {tab === 'missions' && <MissionQueue queue={queue} selId={creating ? null : (sel?.id ?? null)} onPick={(id) => (setCreating(null), setSelId(id))} query={query} setQuery={setQuery} />}
          {tab === 'routes' && <RouteList routes={library} selId={naming === null ? (route?.id ?? null) : null} onPick={(id) => (setNaming(null), setRouteSel(id))} canAdd={canRoutes} onAdd={() => setNaming('')} />}
          {tab === 'patrols' && (
            <div className="mp-scroll">
              <PatrolsCard key={patrolRoute ?? 'list'} selected={patrol?.id ?? null} onSelect={setPatrolSel} startWithRoute={patrolRoute} />
            </div>
          )}
        </aside>

        <section className="mp-stage" aria-label={t('Route on the map')}>
          <div className="panel mp-stage-head">
            {tab === 'missions' && (creating ? <StageTitle eyebrow="NEW MISSION" title={t('New mission')} /> : sel ? <MissionTitle m={sel} /> : <StageTitle eyebrow="MISSION" title={t('No mission selected')} />)}
            {tab === 'missions' && (creating || sel) && <StepBar m={creating ? undefined : sel} />}
            {tab === 'routes' && <StageTitle eyebrow="SAVED ROUTE" title={naming !== null ? t('New route') : (route?.name ?? t('No saved routes yet'))} />}
            {tab === 'patrols' && <StageTitle eyebrow="PATROL" title={patrol?.name ?? t('No patrol schedules yet')} sub={patrol ? `${patrol.deviceId} · ${patrol.times.join(', ')}` : undefined} />}
          </div>
          <div className="panel mp-map">
            <MainMap />
          </div>
          <StageStats
            n={
              tab === 'missions'
                ? sel && routeNumbers(RUNNING.includes(sel.status) ? sel.checkpoints.slice(sel.nextCp) : sel.checkpoints, s.devices[sel.deviceId])
                : tab === 'routes'
                  ? route && naming === null && routeNumbers(route.points)
                  : patrol && routeNumbers(patrol.route, s.devices[patrol.deviceId])
            }
            left={tab === 'missions' && !!sel && RUNNING.includes(sel.status)}
            noVehicle={tab === 'routes'}
          />
        </section>

        <aside className="mp-side" aria-label={t('Planning steps')}>
          {tab === 'missions' &&
            (creating ? (
              <NewMission c={creating} setC={setCreating} onDone={doneCreating} />
            ) : sel ? (
              <MissionDetail key={sel.id} m={sel} />
            ) : (
              <Empty
                icon={<ListChecks size={30} />}
                title={t('Nothing to plan yet')}
                text={t('Start a mission for a confirmed incident, or plan a routine task such as a fence check.')}
                action={canPrepare ? { label: t('New mission'), run: () => newMission() } : undefined}
              />
            ))}
          {tab === 'routes' &&
            (naming !== null ? (
              <NewRoute name={naming} setName={setNaming} msg={libMsg} />
            ) : route ? (
              <RouteDetail
                key={route.id}
                r={route}
                canEdit={canRoutes}
                msg={libMsg}
                onUse={() => newMission({ source: 'task', route: `lib:${route.id}` })}
                onPatrol={can(me.role, 'patrol.manage') && session ? () => (setPatrolRoute(`lib:${route.id}`), setTab('patrols')) : undefined}
                onDeleted={() => setRouteSel(null)}
              />
            ) : (
              <Empty
                icon={<FolderOpen size={30} />}
                title={t('No saved routes yet')}
                text={session ? t('Draw a route once and use it for missions and patrols.') : t('Saved routes are kept on the platform server.')}
                action={canRoutes ? { label: t('New route'), run: () => setNaming('') } : undefined}
              />
            ))}
          {tab === 'patrols' && <PatrolSide patrol={patrol} />}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missions tab
// ---------------------------------------------------------------------------

function MissionQueue({ queue, selId, onPick, query, setQuery }: { queue: ReturnType<typeof missionQueue>; selId: string | null; onPick: (id: string) => void; query: string; setQuery: (q: string) => void }) {
  const t = useT();
  const [allEnded, setAllEnded] = useState(false);
  const total = queue.mine.length + queue.running.length + queue.planning.length + queue.ended.length;
  const ended = allEnded ? queue.ended : queue.ended.slice(0, 6);
  return (
    <>
      <label className="lg-search mp-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search missions…')} aria-label={t('Search missions…')} />
      </label>
      <div className="mp-scroll">
        <Group title={t('Waiting for you')} items={queue.mine} selId={selId} onPick={onPick} accent />
        <Group title={t('Running')} items={queue.running} selId={selId} onPick={onPick} />
        <Group title={t('Being planned')} items={queue.planning} selId={selId} onPick={onPick} />
        <Group title={t('Finished')} items={ended} count={queue.ended.length} selId={selId} onPick={onPick} />
        {queue.ended.length > ended.length && (
          <button type="button" className="btn-ghost small mp-more" onClick={() => setAllEnded(true)}>
            {t('Show all {n}', { n: queue.ended.length })}
          </button>
        )}
        {!total && <p className="empty">{query ? t('No missions match the search.') : t('No missions yet.')}</p>}
      </div>
    </>
  );
}

function Group({ title, items, count, selId, onPick, accent }: { title: string; items: QueueItem[]; count?: number; selId: string | null; onPick: (id: string) => void; accent?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={`mp-group${accent ? ' is-accent' : ''}`}>
      <div className="mp-group-h">
        <span>{title}</span>
        <b>{count ?? items.length}</b>
      </div>
      {items.map((x) => (
        <MissionCard key={x.m.id} item={x} selected={x.m.id === selId} onPick={() => onPick(x.m.id)} />
      ))}
    </div>
  );
}

function MissionCard({ item: { m, turn }, selected, onPick }: { item: QueueItem; selected: boolean; onPick: () => void }) {
  const { s } = useStore();
  const t = useT();
  const { kind, title } = missionPurpose(s, m);
  const n = routeNumbers(RUNNING.includes(m.status) ? m.checkpoints.slice(m.nextCp) : m.checkpoints, s.devices[m.deviceId]);
  const total = m.checkpoints.length;
  return (
    <button type="button" className={`mp-card${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={onPick}>
      <span className="mp-card-top">
        <span className="mono">{m.id}</span>
        <MissionBadge status={m.status} />
      </span>
      <b className="mp-card-title">
        <KindTag kind={kind} />
        {title}
      </b>
      <small>
        {m.deviceId} · {userName(s, m.operatorId)}
      </small>
      <small>
        {t('{n} checkpoints', { n: total })} · {n.lengthM} m · {fmtEta(n.timeS)}
      </small>
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
    </button>
  );
}

function KindTag({ kind }: { kind: 'incident' | 'task' | 'patrol' }) {
  const t = useT();
  if (kind === 'incident') return null;
  return <span className={`mp-kind k-${kind}`}>{kind === 'task' ? t('Routine task') : t('Patrol')}</span>;
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

function StageStats({ n, left, noVehicle }: { n?: RouteNumbers | false; left?: boolean; noVehicle?: boolean }) {
  const t = useT();
  if (!n) return <div className="panel mp-stats mp-stats-empty">{t('Pick a mission or a route to see it on the map.')}</div>;
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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
  const open = s.incidents
    .filter((i) => i.status === 'confirmed' && i.type !== ROUTINE_TASK_TYPE && !i.patrolId)
    .filter((i) => !s.missions.some((m) => m.incidentId === i.id && !ENDED.includes(m.status)))
    .sort((a, b) => b.createdAt - a.createdAt);
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
          <button type="button" aria-pressed={c.source === 'incident'} className={c.source === 'incident' ? 'on' : ''} onClick={() => setC({ ...c, source: 'incident' })}>
            <Siren size={14} /> {t('A confirmed incident')}
          </button>
          <button type="button" aria-pressed={c.source === 'task'} className={c.source === 'task' ? 'on' : ''} onClick={() => setC({ ...c, source: 'task' })}>
            <ListChecks size={14} /> {t('A routine task')}
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

function Empty({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: { label: string; run: () => void } }) {
  return (
    <section className="panel mp-box mp-empty">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button type="button" className="btn-secondary" onClick={action.run}>
          <Plus size={15} /> {action.label}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Saved routes tab
// ---------------------------------------------------------------------------

function RouteList({ routes, selId, onPick, canAdd, onAdd }: { routes: SavedRoute[]; selId: string | null; onPick: (id: string) => void; canAdd: boolean; onAdd: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const shown = routes.filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <label className="lg-search mp-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search routes…')} aria-label={t('Search routes…')} />
      </label>
      <div className="mp-scroll">
        {shown.map((r) => {
          const n = routeNumbers(r.points);
          return (
            <button key={r.id} type="button" className={`mp-card${r.id === selId ? ' is-selected' : ''}`} aria-pressed={r.id === selId} onClick={() => onPick(r.id)}>
              <b className="mp-card-title">{r.name}</b>
              <small>
                {t('{n} checkpoints', { n: n.checkpoints })} · {n.lengthM} m · {fmtEta(n.timeS)}
              </small>
              <small>
                {n.captures > 0 && (
                  <>
                    <Camera size={11} /> {n.captures} ·{' '}
                  </>
                )}
                {t('Updated {date}', { date: fmtDate(r.updatedAt) })}
              </small>
            </button>
          );
        })}
        {!shown.length && <p className="empty">{routes.length ? t('No routes match the search.') : t('No saved routes yet.')}</p>}
        {canAdd && !routes.length && (
          <button type="button" className="btn-secondary small mp-more" onClick={onAdd}>
            <Plus size={14} /> {t('New route')}
          </button>
        )}
      </div>
    </>
  );
}

function NewRoute({ name, setName, msg }: { name: string; setName: (v: string | null) => void; msg: { ok: boolean; text: string } | null }) {
  const t = useT();
  const draft = useRouteDraft();
  const drawing = draft?.state === 'drawing' && draft.purpose === 'library';
  return (
    <section className="panel mp-box">
      <div className="panel-head">
        <div>
          <span className="lg-eyebrow">SAVED ROUTE</span>
          <h2>{t('New route')}</h2>
        </div>
        <button
          type="button"
          className="btn-ghost small"
          onClick={() => {
            if (routeDraft.get()?.purpose === 'library') routeDraft.clear();
            setName(null);
          }}
          aria-label={t('Close')}
        >
          <X size={16} />
        </button>
      </div>
      <div className="step">
        <label className="field">
          <span>{t('Route name')}</span>
          <input value={name} maxLength={60} placeholder={t('Route name, e.g. Night loop')} onChange={(e) => setName(e.target.value)} autoFocus disabled={drawing} />
        </label>
        {drawing ? (
          <p className="fine">{t('Click the map to add checkpoints, then press “Save route” in the map panel.')}</p>
        ) : (
          <button type="button" className="btn-primary" disabled={!name.trim()} onClick={() => routeDraft.start({ purpose: 'library', deviceId: '', points: [], meta: { name: name.trim() } satisfies LibraryMeta })}>
            <MapPinned size={15} /> {t('Draw on the map')}
          </button>
        )}
        {msg && <p className={msg.ok ? 'fine' : 'mp-bad'}>{msg.text}</p>}
      </div>
    </section>
  );
}

function RouteDetail({ r, canEdit, msg, onUse, onPatrol, onDeleted }: { r: SavedRoute; canEdit: boolean; msg: { ok: boolean; text: string } | null; onUse: () => void; onPatrol?: () => void; onDeleted: () => void }) {
  const { s, session } = useStore();
  const t = useT();
  const [rename, setRename] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const draft = useRouteDraft();
  const editing = draft?.state === 'drawing' && draft.purpose === 'library' && (draft.meta as LibraryMeta | undefined)?.id === r.id;
  const call = async (fn: () => Promise<unknown>) => {
    if (!session) return;
    try {
      setErr(null);
      await fn();
      await savedRoutes.refresh(session.api, s.site?.id);
    } catch (e) {
      setErr(t(e instanceof Error ? e.message : String(e)));
    }
  };
  return (
    <>
      <section className="panel mp-box">
        <div className="panel-head">
          <div>
            <span className="lg-eyebrow">SAVED ROUTE</span>
            <h2>{r.name}</h2>
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
          <small className="fine">
            {t('Updated {date}', { date: `${fmtDate(r.updatedAt)} ${fmtTime(r.updatedAt)}` })} · {userName(s, r.createdBy)}
          </small>
        </div>
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
                    <button type="button" className="btn-ghost small danger" onClick={() => void call(() => session!.api.del(`/saved-routes/${encodeURIComponent(r.id)}`)).then(onDeleted)}>
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
                if (rename.trim()) void call(() => session!.api.patch(`/saved-routes/${encodeURIComponent(r.id)}`, { name: rename.trim() })).then(() => setRename(null));
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
// Scheduled patrols tab
// ---------------------------------------------------------------------------

function PatrolSide({ patrol }: { patrol?: Patrol }) {
  const { s } = useStore();
  const t = useT();
  const runs = useMemo(() => upcomingRuns(s.patrols, Date.now(), 7), [s.patrols]);
  const days = new Map<string, typeof runs>();
  for (const r of runs) {
    const k = fmtDate(r.at);
    days.set(k, [...(days.get(k) ?? []), r]);
  }
  return (
    <>
      {patrol && (
        <section className="panel mp-box">
          <div className="panel-head">
            <div>
              <span className="lg-eyebrow">PATROL · {patrol.id}</span>
              <h2>{patrol.name}</h2>
            </div>
          </div>
          <dl className="mp-facts">
            <div>
              <dt>{t('Vehicle')}</dt>
              <dd>{patrol.deviceId}</dd>
            </div>
            <div>
              <dt>{t('Operator')}</dt>
              <dd>{userName(s, patrol.operatorId)}</dd>
            </div>
            <div>
              <dt>{t('Approved by')}</dt>
              <dd>{userName(s, patrol.createdBy)}</dd>
            </div>
            <div>
              <dt>{t('Start')}</dt>
              <dd>{patrol.autoStart ? t('Automatic when ready') : t('By the operator')}</dd>
            </div>
            <div>
              <dt>{t('Next run')}</dt>
              <dd>{patrol.enabled && patrol.nextRunAt ? `${fmtDate(patrol.nextRunAt)} ${fmtTime(patrol.nextRunAt)}` : t('Disabled')}</dd>
            </div>
            <div>
              <dt>{t('Last run')}</dt>
              <dd>{patrol.lastRunAt ? `${fmtTime(patrol.lastRunAt)} · ${t(patrol.lastOutcome ?? '—')}` : '—'}</dd>
            </div>
          </dl>
        </section>
      )}
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
                  <li key={`${r.patrol.id}:${r.at}`} className={r.patrol.id === patrol?.id ? 'is-selected' : ''}>
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
