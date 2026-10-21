import { AlertTriangle, Camera, Cpu, Radio, ShieldAlert } from 'lucide-react';
import type { Device } from '@13store/shared';
import { freshness } from '../domain/policy';
import { useStore } from '../store';

/**
 * A read-only hardware gate. Never infer that a camera, depth sensor, brake or
 * physical E-stop is verified from a MAVLink heartbeat or simulator telemetry.
 * Real-world readiness must be signed off on site, outside of the browser.
 */
export function UgvHardwareReadiness({ device }: { device: Device }) {
  const { s } = useStore();
  if (device.kind !== 'ugv') return null;
  const link = freshness(s, device);
  const live = link === 'live';
  const capabilities = new Set(device.capabilities);
  const rows = [
    { name: 'Vehicle telemetry', detail: live ? 'Fresh platform telemetry — not hardware sign-off' : 'Telemetry unavailable or stale', ok: live, icon: Radio },
    { name: 'SIYI / MAVLink', detail: 'Adapter supported; verify firmware, steering, throttle and control priority on this vehicle', ok: false, icon: Cpu },
    { name: 'Onboard / PTZ camera', detail: capabilities.has('camera') || capabilities.has('gimbal') ? 'Capability declared; video and pan/tilt require field test' : 'No camera capability declared', ok: false, icon: Camera },
    { name: 'Depth vision / obstacle stop', detail: 'Requires calibrated depth sensor, confidence gating and on-site obstacle testing', ok: false, icon: Camera },
    { name: 'Physical E-stop / engine failsafe', detail: 'Independent hardwired stop, braking and link-loss test required', ok: false, icon: ShieldAlert },
  ];
  return (
    <section className="panel cc-box" aria-label="UGV hardware readiness">
      <div className="panel-head"><h2>UGV hardware readiness</h2></div>
      <div className="cc-box-body">
        <div role="status" style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}>
          <AlertTriangle size={16} aria-hidden="true" />
          <strong>{s.replay.active ? 'REPLAY — control disabled' : 'FIELD VERIFICATION REQUIRED'}</strong>
        </div>
        <p style={{fontSize:12,opacity:.85,margin:'0 0 10px'}}>
          This is a read-only checklist, not an unlock for driving. A live link does not prove the actual tracked UGV is safe.
        </p>
        <ul style={{listStyle:'none',margin:0,padding:0,display:'grid',gap:10}}>
          {rows.map(({name,detail,ok,icon:Icon}) => (
            <li key={name} style={{display:'flex',alignItems:'flex-start',gap:9}}>
              <Icon size={17} style={{flexShrink:0,marginTop:2}} aria-hidden="true" />
              <span><b>{name} · {ok ? 'TELEMETRY LIVE' : 'NOT VERIFIED'}</b><br/><small>{detail}</small></span>
            </li>
          ))}
        </ul>
        <p style={{fontSize:12,opacity:.85,margin:'12px 0 0'}}>
          Do not operate unattended until throttle, steering, mechanical brakes, local RC override,
          physical E-stop and loss-of-link behavior pass supervised field tests.
        </p>
      </div>
    </section>
  );
}
