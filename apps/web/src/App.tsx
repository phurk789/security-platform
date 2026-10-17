import { useState } from 'react';
import { History, List, Map as MapIcon, PanelRight, Radio } from 'lucide-react';
import { fmtTime } from './domain/policy';
import { useStore } from './store';
import { useT } from './i18n';
import { RightPanel } from './components/IncidentPanel';
import { BottomTimeline, Footer, IncidentQueue, Kpis, SideNav, Toasts, TopBar } from './components/Shell';
import { TwinMap } from './components/TwinMap';
import { FleetPanel, useTheme, useWide } from './components/Hud';
import { DevicesPage, EvidencePage, IncidentsPage, MissionsPage, ReportsPage } from './views/Pages';
import { AdminPage } from './views/Admin';
import { CommandCenter } from './views/CommandCenter';

export function App() {
  const { s } = useStore();
  const theme = useTheme();
  return (
    <div className={`app theme-${theme}${s.presentation ? ' presentation' : ''}${s.replay.active ? ' is-replay' : ''}`}>
      <TopBar />
      <div className="main">
        <SideNav />
        {s.view === 'overview' && <Overview />}
        {s.view === 'command' && <CommandCenter />}
        {s.view === 'incidents' && <IncidentsPage />}
        {s.view === 'missions' && <MissionsPage />}
        {s.view === 'devices' && <DevicesPage />}
        {s.view === 'evidence' && <EvidencePage />}
        {s.view === 'reports' && <ReportsPage />}
        {s.view === 'admin' && <AdminPage />}
      </div>
      <Footer />
      <Toasts />
    </div>
  );
}

function Overview() {
  const { s, dispatch } = useStore();
  const t = useT();
  // Small screens show one pane at a time (UXUI §4).
  const [pane, setPane] = useState<'map' | 'queue' | 'detail'>('map');
  const theme = useTheme();
  const wide = useWide();
  const hud = theme === 'hud' && wide;
  const replayBar = s.replay.active && (
    <div className="replay-bar inline">
      <History size={16} /> <b>REPLAY</b> <span className="mono">{fmtTime(s.replay.at, true)}</span>
      <span>{t('You are viewing past data. Device control is off.')}</span>
      <button className="btn-primary small" onClick={() => dispatch({ type: 'exitReplay' })}><Radio size={14} /> {t('Return to live')}</button>
    </div>
  );
  if (hud) {
    // Twin HUD: the 3D city fills the screen; panels float around it.
    return (
      <div className="overview hud">
        <div className="center">
          {replayBar}
          <Kpis />
          <TwinMap />
        </div>
        <div className="hud-left">
          <FleetPanel />
          <IncidentQueue />
        </div>
        <div className="ov-right">
          <RightPanel />
        </div>
        <div className="hud-bottom">
          <BottomTimeline />
        </div>
      </div>
    );
  }
  return (
    <div className={`overview pane-${pane}`}>
      <div className="mobile-tabs" role="tablist">
        <button className={pane === 'queue' ? 'on' : ''} onClick={() => setPane('queue')}><List size={16} /> {t('Queue')}</button>
        <button className={pane === 'map' ? 'on' : ''} onClick={() => setPane('map')}><MapIcon size={16} /> {t('Map')}</button>
        <button className={pane === 'detail' ? 'on' : ''} onClick={() => setPane('detail')}><PanelRight size={16} /> {t('Details')}</button>
      </div>
      <div className="ov-queue" onClick={(e) => (e.target as Element).closest('.inc-card') && setPane('detail')}>
        <IncidentQueue />
      </div>
      <div className="center">
        {replayBar}
        <Kpis />
        <TwinMap />
      </div>
      <div className="ov-right">
        <RightPanel />
      </div>
      <BottomTimeline />
    </div>
  );
}
