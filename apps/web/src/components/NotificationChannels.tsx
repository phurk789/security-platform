// Administration: outbound notification channels (webhook, LINE, SMS gateway) with a test
// button and the recent delivery log. Secrets are shown masked and sent back as the mask.
import { useCallback, useEffect, useState } from 'react';
import { BellRing, Plus, Send, Trash2 } from 'lucide-react';
import { NOTIFY_EVENTS, NOTIFY_EVENT_LABEL, fmtDate, fmtTime, type NotificationChannel, type NotificationDelivery, type NotifyEvent, type OrgSettings } from '@13store/shared';
import { ApiError } from '../api';
import { useStore } from '../store';
import { useT } from '../i18n';

const EMPTY = {
  id: '',
  name: '',
  kind: 'webhook' as NotificationChannel['kind'],
  events: ['incident.new', 'sla.breach'] as NotifyEvent[],
  minSeverity: '' as '' | 'low' | 'medium' | 'high',
  url: '',
  secret: '',
  token: '',
  to: '',
  smsBody: '',
};

export function NotificationChannels({ onStepUp }: { onStepUp: (retry: () => void) => void }) {
  const { session } = useStore();
  const t = useT();
  const api = session!.api;
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [log, setLog] = useState<NotificationDelivery[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ...EMPTY });

  const load = useCallback(async () => {
    const [st, lg] = await Promise.all([api.get<OrgSettings>('/admin/settings'), api.get<NotificationDelivery[]>('/admin/notifications/log?limit=20')]);
    setChannels(st.notifications.channels);
    setLog(lg);
  }, [api]);
  useEffect(() => {
    load().catch((e) => setMsg({ tone: 'warn', text: e.message }));
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'ok', text: ok });
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'step_up_required') onStepUp(() => void act(fn, ok));
      else setMsg({ tone: 'warn', text: e instanceof Error ? e.message : String(e) });
    }
  };
  const save = (next: NotificationChannel[], ok: string) => act(() => api.patch('/admin/settings', { notifications: { channels: next } }), ok);

  const build = (): NotificationChannel => {
    const base: NotificationChannel = {
      id:
        f.id.trim() ||
        f.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 32) ||
        `ch-${Date.now().toString(36)}`,
      name: f.name.trim(),
      kind: f.kind,
      enabled: true,
      events: f.events,
      minSeverity: f.minSeverity || undefined,
    };
    if (f.kind === 'webhook') base.webhook = { url: f.url.trim(), secret: f.secret.trim() || undefined };
    if (f.kind === 'line') base.line = { token: f.token.trim(), to: f.to.trim() };
    if (f.kind === 'sms') base.sms = { url: f.url.trim(), method: 'POST', to: f.to.split(/[,\s]+/).filter(Boolean), body: f.smsBody.trim() || undefined };
    return base;
  };
  const valid =
    f.name.trim() &&
    f.events.length &&
    (f.kind === 'webhook' ? /^https?:\/\//.test(f.url) : f.kind === 'line' ? f.token.trim() && f.to.trim() : /^https?:\/\//.test(f.url) && f.to.trim());

  return (
    <section className="card">
      <div className="row between wrap">
        <h3>
          <BellRing size={16} /> {t('Notification channels')} <small className="muted">({channels.length})</small>
        </h3>
        <button className="btn-secondary small" onClick={() => setOpen((o) => !o)}>
          <Plus size={14} /> {t('Add channel')}
        </button>
      </div>
      <p className="fine" style={{ marginTop: 0 }}>
        {t(
          'Where the platform sends alerts, SLA breaches, geofence breaches and other events: a signed webhook (any system), a LINE group through the Messaging API, or an HTTP SMS gateway. Every delivery is logged.',
        )}
      </p>
      {msg && <p className={`banner ${msg.tone === 'ok' ? 'info' : 'warn'}`}>{msg.text}</p>}
      <ul className="list">
        {channels.map((c) => (
          <li key={c.id} className={c.enabled ? '' : 'dim'}>
            <span>
              <b>{c.name}</b>{' '}
              <small className="muted">
                · {c.kind.toUpperCase()} · {c.kind === 'webhook' ? c.webhook?.url : c.kind === 'line' ? `to ${c.line?.to}` : `${c.sms?.to.length} numbers`}
              </small>
              <br />
              <small className="muted">
                {c.events.map((e) => t(NOTIFY_EVENT_LABEL[e])).join(', ')}
                {c.minSeverity ? ` · ${t('severity ≥ {s}', { s: t(c.minSeverity) })}` : ''}
              </small>
            </span>
            <span className="row gap-s">
              <button
                className="btn-ghost small"
                onClick={() =>
                  act(async () => {
                    const d = await api.post<NotificationDelivery>('/admin/notifications/test', { channelId: c.id });
                    setMsg(
                      d.status === 'sent'
                        ? { tone: 'ok', text: t('Test sent through {name}: {detail}', { name: c.name, detail: d.detail ?? '' }) }
                        : { tone: 'warn', text: t('Test failed through {name}: {detail}', { name: c.name, detail: d.detail ?? '' }) },
                    );
                  })
                }
              >
                <Send size={14} /> {t('Test')}
              </button>
              <button
                className="btn-ghost small"
                onClick={() =>
                  save(
                    channels.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)),
                    c.enabled ? t('{name} disabled.', { name: c.name }) : t('{name} enabled.', { name: c.name }),
                  )
                }
              >
                {c.enabled ? t('Disable') : t('Enable')}
              </button>
              <button
                className="btn-ghost small"
                onClick={() =>
                  save(
                    channels.filter((x) => x.id !== c.id),
                    t('{name} removed.', { name: c.name }),
                  )
                }
                aria-label={t('Remove')}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {open && (
        <form
          className="patrol-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            void save([...channels, build()], t('Channel {name} saved.', { name: f.name.trim() })).then(() => {
              setOpen(false);
              setF({ ...EMPTY });
            });
          }}
        >
          <input placeholder={t('Name, e.g. Ops LINE group')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as NotificationChannel['kind'] })} aria-label={t('Kind')}>
            <option value="webhook">{t('Webhook (signed JSON)')}</option>
            <option value="line">{t('LINE Messaging API')}</option>
            <option value="sms">{t('SMS gateway (HTTP)')}</option>
          </select>
          {f.kind !== 'line' && (
            <input
              placeholder={f.kind === 'webhook' ? 'https://…/hooks/security' : 'https://sms.example.com/send?to={to}&text={text}'}
              value={f.url}
              onChange={(e) => setF({ ...f, url: e.target.value })}
            />
          )}
          {f.kind === 'webhook' && (
            <input placeholder={t('Shared secret for X-PST-Signature (optional)')} value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />
          )}
          {f.kind === 'line' && <input placeholder={t('Channel access token')} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}
          {f.kind === 'line' && <input placeholder={t('Group, room or user id (to)')} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}
          {f.kind === 'sms' && <input placeholder={t('Numbers, comma separated')} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}
          {f.kind === 'sms' && (
            <input placeholder={t('POST body template, e.g. to={to}&msg={text} (empty = JSON)')} value={f.smsBody} onChange={(e) => setF({ ...f, smsBody: e.target.value })} />
          )}
          <div className="chips">
            {NOTIFY_EVENTS.map((ev) => (
              <button
                key={ev}
                type="button"
                className={`chip ${f.events.includes(ev) ? 'on' : ''}`}
                onClick={() => setF({ ...f, events: f.events.includes(ev) ? f.events.filter((x) => x !== ev) : [...f.events, ev] })}
              >
                {t(NOTIFY_EVENT_LABEL[ev])}
              </button>
            ))}
          </div>
          <label className="check">
            {t('Incident events only at severity')}
            <select value={f.minSeverity} onChange={(e) => setF({ ...f, minSeverity: e.target.value as typeof f.minSeverity })}>
              <option value="">{t('any')}</option>
              <option value="medium">{t('medium')} +</option>
              <option value="high">{t('high')}</option>
            </select>
          </label>
          <div className="row gap-s">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </button>
            <button className="btn-primary" disabled={!valid}>
              {t('Save channel')}
            </button>
          </div>
        </form>
      )}
      {log.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 6px' }}>{t('Recent deliveries')}</h4>
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>{t('Time')}</th>
                  <th>{t('Channel')}</th>
                  <th>{t('Event')}</th>
                  <th>{t('Status')}</th>
                  <th>{t('Detail')}</th>
                </tr>
              </thead>
              <tbody>
                {log.map((d) => (
                  <tr key={d.id} className={d.status === 'failed' ? 'denied' : ''}>
                    <td className="mono">
                      {fmtDate(d.at)} {fmtTime(d.at, true)}
                    </td>
                    <td>{d.channelName}</td>
                    <td className="mono">{d.event}</td>
                    <td>{d.status === 'sent' ? <span className="badge badge-green">{t('sent')}</span> : <span className="badge badge-red solid">{t('failed')}</span>}</td>
                    <td className="wrap-cell">
                      {d.title}
                      {d.detail ? <small className="muted"> · {d.detail}</small> : null}
                      {d.attempts > 1 ? <small className="muted"> · {t('{n} attempts', { n: d.attempts })}</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
