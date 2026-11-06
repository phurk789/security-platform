// Arm, disarm, MANUAL/HOLD and gear from the console, for vehicles whose gateway offers them (vehicleControl).
// Disarm and HOLD are always here: they only make a vehicle safer. A vehicle with no hand-held remote (its gateway is
// the remote) is also armed here, by a supervisor who confirms nobody is near it, then switched to MANUAL and given a
// gear. The server checks all of it again (apps/server/src/platform.ts vehicleControl) and audits every request.
import { useState } from 'react';
import { Hand, OctagonX, Power } from 'lucide-react';
import { modeOf, type Device, type VehicleControlAction } from '@13store/shared';
import { can, currentUser, freshness } from '../domain/policy';
import { gearOf } from '../domain/vehicleControl';
import { useT } from '../i18n';
import { useStore } from '../store';
import './drive.css';

export function VehicleControls({ d }: { d: Device }) {
  const { s, session } = useStore();
  const t = useT();
  const role = currentUser(s).role;
  const vc = d.vehicleControl!;
  const [busy, setBusy] = useState(false);
  const [clear, setClear] = useState(false);
  const live = modeOf(d) === 'LIVE_MANUAL' && freshness(s, d) === 'live';
  const part = d.components?.find((c) => c.id === 'remote');
  const gear = gearOf(part?.detail);
  const canSafe = can(role, 'device.disarm');
  const canCommand = can(role, 'device.command');

  const send = async (action: VehicleControlAction, confirmClear?: boolean) => {
    if (!session) return;
    setBusy(true);
    try {
      await session.vehicleControl(d.id, action, confirmClear);
      if (action.kind === 'arm') setClear(false);
    } finally {
      setBusy(false);
    }
  };

  if (!canSafe && !canCommand) return null;
  return (
    <section className="panel cc-box drive vehicle-ctl">
      <div className="panel-head">
        <h2>
          <Power size={15} /> {t('Vehicle')}
        </h2>
        {vc.noRemote && <span className="badge badge-amber">{t('No remote')}</span>}
      </div>
      <div className="cc-box-body">
        <p className="vc-state">
          <b className={d.armed ? 'vc-armed' : ''}>{d.armed === undefined ? '—' : d.armed ? t('ARMED') : t('Disarmed')}</b>
          {d.flightMode && <span className="mono">{d.flightMode}</span>}
        </p>
        {part?.detail && <p className={`drive-state tone-${part.status}`}>{t(part.detail)}</p>}

        {canSafe && (
          <button className="drive-stop" disabled={busy || d.armed === false} onClick={() => void send({ kind: 'disarm' })}>
            <OctagonX size={18} /> {t('DISARM · motors off')}
          </button>
        )}
        <div className="vc-row">
          {canSafe && (
            <button className="btn-secondary" disabled={busy} onClick={() => void send({ kind: 'mode', mode: 'hold' })}>
              <Hand size={15} /> HOLD
            </button>
          )}
          {vc.noRemote && canCommand && (
            <button className="btn-secondary" disabled={busy || !live} onClick={() => void send({ kind: 'mode', mode: 'manual' })}>
              MANUAL
            </button>
          )}
        </div>

        {vc.noRemote && vc.gears > 0 && canCommand && (
          <div className="vc-gears" role="group" aria-label={t('Gear')}>
            <small>{t('Gear')}</small>
            {Array.from({ length: vc.gears }, (_, i) => i + 1).map((g) => (
              <button key={g} className={`btn-secondary${gear === g ? ' on' : ''}`} aria-pressed={gear === g} disabled={busy || !live} onClick={() => void send({ kind: 'gear', gear: g })}>
                {g}
              </button>
            ))}
          </div>
        )}

        {vc.noRemote && d.armed !== true && can(role, 'device.arm') && (
          <div className="vc-arm">
            {!live && <p className="muted">{t('Arming needs LIVE MANUAL and live telemetry.')}</p>}
            <label className="drive-check">
              <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} />
              <span>{t('I can see the vehicle or its video, nobody is near it, and DISARM is in reach.')}</span>
            </label>
            <button className="btn-primary wide" disabled={busy || !live || !clear} onClick={() => void send({ kind: 'arm' }, true)}>
              <Power size={16} /> {t('Arm')}
            </button>
          </div>
        )}
        {vc.noRemote && d.armed !== true && !can(role, 'device.arm') && <p className="fine">{t('A supervisor arms this vehicle from here.')}</p>}
        {!vc.noRemote && <p className="fine">{t('Arming and MANUAL stay on the remote. DISARM and HOLD work from here too.')}</p>}
      </div>
    </section>
  );
}
