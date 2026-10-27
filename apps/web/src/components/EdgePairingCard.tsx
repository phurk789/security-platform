// Admin → "Pair an edge remote" (CLEANUP_PLAN E-3). Creates a one-time code (6 digits + QR) that the
// edge app on the SIYI remote exchanges for its gateway key and site configuration. The key never
// appears here: the server hands it straight to the app.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { QrCode, Smartphone, X } from 'lucide-react';
import { PAIRING_CODE_TTL_MIN, fmtTime, type PairingCodeView } from '@13store/shared';
import type { Api } from '../api';
import { useT } from '../i18n';
import { REMOTE_DEFAULTS, formatCode, loopbackOrigin, pairingQr, readDeviceList, remoteDevices, timeLeft, unregistered, type RemoteForm } from '../domain/pairing';

const STATUS_TONE: Record<PairingCodeView['status'], string> = { waiting: 'badge-amber', paired: 'badge-green', expired: 'badge-grey', cancelled: 'badge-grey' };
const STATUS_LABEL: Record<PairingCodeView['status'], string> = { waiting: 'Waiting', paired: 'Paired', expired: 'Expired', cancelled: 'Cancelled' };

export function EdgePairingCard({
  api,
  act,
  registered,
  reloadKey,
}: {
  api: Api;
  /** The Admin page's action runner: shows errors and asks for the password again when needed. */
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  /** Device ids registered on the server. */
  registered: string[];
  /** Changes when the Admin page reloads. */
  reloadKey: number;
}) {
  const t = useT();
  const [codes, setCodes] = useState<PairingCodeView[]>([]);
  const [form, setForm] = useState<RemoteForm>(REMOTE_DEFAULTS);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState('');
  const [shown, setShown] = useState<PairingCodeView | null>(null);
  const [now, setNow] = useState(Date.now());
  const server = window.location.origin;

  const load = useCallback(() => api.get<PairingCodeView[]>('/admin/pairing-codes').then(setCodes), [api]);
  useEffect(() => {
    load().catch(() => {});
  }, [load, reloadKey]);

  // Countdown, and pick up "paired" while a code is on screen.
  useEffect(() => {
    if (!shown) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => load().catch(() => {}), 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [shown, load]);
  const live = shown && codes.find((c) => c.id === shown.id);
  const status = live?.status ?? shown?.status;

  const parsed = advanced ? readDeviceList(json) : { devices: remoteDevices(form), ids: [form.vehicleId.trim().toUpperCase()] };
  const missing = 'ids' in parsed ? unregistered(parsed.ids, registered) : [];
  const qr = useMemo(() => (shown?.code ? pairingQr(server, shown.code) : null), [shown, server]);

  const create = () =>
    act(async () => {
      if ('error' in parsed) throw new Error(t('Device list: {error}', { error: parsed.error }));
      const c = await api.post<PairingCodeView>('/admin/pairing-codes', { label: form.label, gatewayId: form.gatewayId.trim(), devices: parsed.devices });
      setShown(c);
      setNow(Date.now());
      await load();
    });

  const left = shown ? timeLeft(shown.expiresAt, now) : null;

  return (
    <section className="card">
      <h3>
        <Smartphone size={16} /> {t('Pair an edge remote')}
      </h3>
      <p className="fine" style={{ marginTop: 0 }}>
        {t(
          'For the edge app on the SIYI remote. Create a code, then on the remote press Pair and scan the QR or type the server address and the 6 digits. The app receives its gateway key directly: no one sees or types it. A code works once, for {n} minutes.',
          { n: PAIRING_CODE_TTL_MIN },
        )}
      </p>

      {shown && qr && (
        <div className="pair-code">
          {status === 'waiting' && left ? (
            <>
              <svg className="pair-qr" viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label={t('QR code for the edge app')} shapeRendering="crispEdges">
                <rect x={-2} y={-2} width={qr.size + 4} height={qr.size + 4} fill="#fff" />
                <path d={qr.path} fill="#000" />
              </svg>
              <div>
                <div className="pair-digits mono" aria-label={t('Pairing code')}>
                  {formatCode(shown.code!)}
                </div>
                <div className="fine">
                  {t('Server address on the remote:')} <b className="mono">{server}</b>
                </div>
                {loopbackOrigin(server) && (
                  <div className="fine warn-text">{t('The remote cannot reach "localhost": open this console by its network address, e.g. http://192.168.20.13:8090, then create the code again.')}</div>
                )}
                <div className="fine">{t('Valid for {left}', { left })}</div>
              </div>
            </>
          ) : (
            <p className={`banner ${status === 'paired' ? 'info' : 'warn'}`} style={{ margin: 0 }}>
              {status === 'paired'
                ? t('{gw} paired. Start the gateway on the remote; the vehicle appears under Devices.', { gw: shown.gatewayId })
                : t('This code can no longer be used. Create a new one.')}
            </p>
          )}
          <button className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={() => setShown(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input id="pair-label" placeholder={t('Name, e.g. SIYI UniRC 7 Pro')} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} aria-label={t('Name')} />
        <input id="pair-gw" placeholder="edge-unirc-01" value={form.gatewayId} onChange={(e) => setForm({ ...form, gatewayId: e.target.value })} aria-label={t('Gateway id')} />
        {!advanced && (
          <>
            <input id="pair-vehicle" placeholder="UGV-01" value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value.toUpperCase() })} aria-label={t('Vehicle id')} />
            <input
              id="pair-camera"
              placeholder={t('Camera RTSP address (empty: no video)')}
              value={form.cameraRtsp}
              onChange={(e) => setForm({ ...form, cameraRtsp: e.target.value })}
              aria-label={t('Camera RTSP address')}
            />
          </>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => {
              setAdvanced(e.target.checked);
              if (e.target.checked && !json) setJson(JSON.stringify(remoteDevices(form), null, 2));
            }}
          />
          {t('Edit the device list (JSON)')}
        </label>
        {advanced && (
          <textarea id="pair-json" className="mono" rows={10} style={{ width: '100%' }} value={json} onChange={(e) => setJson(e.target.value)} aria-label={t('Device list (JSON)')} />
        )}
        <button className="btn-primary" disabled={!form.gatewayId.trim() || (!advanced && !form.vehicleId.trim())}>
          <QrCode size={16} /> {t('Create pairing code')}
        </button>
      </form>
      {'error' in parsed && advanced && <p className="fine warn-text">{t('Device list: {error}', { error: parsed.error })}</p>}
      {missing.length > 0 && <p className="fine warn-text">{t('Register {ids} under "Edge gateways and devices" first, or the server refuses them.', { ids: missing.join(', ') })}</p>}

      {codes.length > 0 && (
        <ul className="list">
          {codes.slice(0, 6).map((c) => {
            const st = c.status === 'waiting' && c.expiresAt <= now ? 'expired' : c.status;
            return (
              <li key={c.id} className={st === 'waiting' || st === 'paired' ? '' : 'dim'}>
                <span>
                  <b>{c.label}</b>{' '}
                  <small className="muted">
                    {c.gatewayId} · {c.deviceIds.join(', ')} · {fmtTime(c.createdAt)} · {c.createdBy}
                    {c.pairedBy ? ` · ${c.pairedBy}` : ''}
                  </small>
                </span>
                <span className="row gap-s">
                  <span className={`badge ${STATUS_TONE[st]}`}>{t(STATUS_LABEL[st])}</span>
                  {st === 'waiting' && (
                    <button className="btn-ghost small" onClick={() => act(() => api.del(`/admin/pairing-codes/${c.id}`).then(load), t('Code cancelled.'))}>
                      {t('Cancel')}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
