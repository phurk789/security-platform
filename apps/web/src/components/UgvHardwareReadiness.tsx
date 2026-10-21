// Read-only hardware readiness of a real UGV (Command Center side column). Never an unlock for
// driving: a live link or a declared capability does not prove the vehicle is safe.
import { Camera, Cpu, Radio, ScanLine, ShieldAlert, type LucideIcon } from 'lucide-react';
import type { Device } from '@13store/shared';
import { freshness } from '../domain/policy';
import { READINESS_LABEL, readinessRows, type ReadinessKey } from '../domain/readiness';
import { useT } from '../i18n';
import { useStore } from '../store';
import { EqStatus } from './DevicePanel';

const ICON: Record<ReadinessKey, LucideIcon> = { telemetry: Radio, controller: Cpu, camera: Camera, depth: ScanLine, estop: ShieldAlert };

export function UgvHardwareReadiness({ device }: { device: Device }) {
  const { s } = useStore();
  const t = useT();
  const rows = readinessRows(device, freshness(s, device) === 'live');
  const open = rows.filter((r) => r.status !== 'ok').length;
  return (
    <section className="panel cc-box" aria-label={t('Hardware readiness')}>
      <div className="panel-head">
        <h2>{t('Hardware readiness')}</h2>
      </div>
      <div className="cc-box-body">
        {open ? (
          <p className="banner warn">
            <ShieldAlert size={15} /> <b>{t('Field verification required')}</b>
            <span>{t('{n} of {total} checks are not passed. Do not run the vehicle unattended.', { n: open, total: rows.length })}</span>
          </p>
        ) : (
          <p className="banner info">{t('All checks passed. This list is for information and does not unlock driving.')}</p>
        )}
        <ul className="eq-list">
          {rows.map((r) => {
            const I = ICON[r.key];
            return (
              <li key={r.key} className={`eq-row s-${r.status}`}>
                <span className="eq-ico">
                  <I size={15} />
                </span>
                <span className="eq-txt">
                  <b>{t(READINESS_LABEL[r.key])}</b>
                  <small>{t(r.detail)}</small>
                </span>
                <EqStatus st={r.status} short />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
