import { useState } from 'react';
import { History, List, Map as MapIcon, PanelRight, Radio } from 'lucide-react';
import { fmtTime } from './domain/policy';
import { useStore } from './store';
import { RightPanel } from './components/IncidentPanel';
import { BottomTimeline, Footer, IncidentQueue, Kpis, SideNav, Toasts, TopBar } from './components/Shell';
import { TwinMap } from './components/TwinMap';
import { DevicesPage, EvidencePage, IncidentsPage, MissionsPage, ReportsPage } from './views/Pages';

export function App() {
  const { s } = useStore();
  return (
    <div className={`app${s.presentation ? ' presentation' : ''}${s.replay.active ? ' is-replay' : ''}`}>
      <TopBar />
      <div className="main">
        <SideNav />
        {s.view === 'overview' && <Overview />}
        {s.view === 'incidents' && <IncidentsPage />}
        {s.view === 'missions' && <MissionsPage />}
        {s.view === 'devices' && <DevicesPage />}
        {s.view === 'evidence' && <EvidencePage />}
        {s.view === 'reports' && <ReportsPage />}
      </div>
      <Footer />
      <Toasts />
    </div>
  );
}

function Overview() {
  const { s, dispatch } = useStore();
  // Small screens show one pane at a time (UXUI §4).
  const [pane, setPane] = useState<'map' | 'queue' | 'detail'>('map');
  return (
    <div className={`overview pane-${pane}`}>
      <div className="mobile-tabs" role="tablist">
        <button className={pane === 'queue' ? 'on' : ''} onClick={() => setPane('queue')}><List size={16} /> Queue</button>
        <button className={pane === 'map' ? 'on' : ''} onClick={() => setPane('map')}><MapIcon size={16} /> Map</button>
        <button className={pane === 'detail' ? 'on' : ''} onClick={() => setPane('detail')}><PanelRight size={16} /> Details</button>
      </div>
      <div className="ov-queue" onClick={(e) => (e.target as Element).closest('.inc-card') && setPane('detail')}>
        <IncidentQueue />
      </div>
      <div className="center">
        {s.replay.active && (
          <div className="replay-bar inline">
            <History size={16} /> <b>REPLAY</b> <span className="mono">{fmtTime(s.replay.at, true)}</span>
            <span>Viewing past data. Device control is off.</span>
            <button className="btn-primary small" onClick={() => dispatch({ type: 'exitReplay' })}><Radio size={14} /> Return to live</button>
          </div>
        )}
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
