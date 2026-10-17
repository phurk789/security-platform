// SOP playbook on an incident: SLA stage chips (time left / overdue / met) and the checklist.
import { Check, ClipboardList, Timer } from 'lucide-react';
import { SLA_STAGE_LABEL, pickPlaybook, slaStages, slaSummary, type Incident, type StageState } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { useStore } from '../store';
import { useT } from '../i18n';

function useStages(inc: Incident): { stages: StageState[]; bookName?: string } {
  const { s } = useStore();
  const book = pickPlaybook(s.playbooks, inc);
  if (!book) return { stages: [] };
  return { stages: slaStages(inc, s.timeline, book.sla, s.now).filter((x) => x.status !== 'na'), bookName: book.name };
}

function fmtLeft(ms: number) {
  const neg = ms < 0;
  const a = Math.abs(ms);
  const m = Math.floor(a / 60_000);
  const sec = Math.floor((a % 60_000) / 1000);
  return `${neg ? '−' : ''}${m}:${String(sec).padStart(2, '0')}`;
}

/** One chip per SLA stage of the incident's playbook. */
export function SlaChips({ inc }: { inc: Incident }) {
  const { s } = useStore();
  const t = useT();
  const { stages, bookName } = useStages(inc);
  if (!stages.length) return null;
  return (
    <div className="sla-chips" title={bookName ? t('Playbook: {name}', { name: bookName }) : undefined}>
      <Timer size={13} />
      {stages.map((st) => (
        <span key={st.stage} className={`sla-chip ${st.status}`}>
          {st.status === 'met' && <Check size={11} />}
          {t(SLA_STAGE_LABEL[st.stage])}{' '}
          <b>
            {st.status === 'met' && st.doneAt !== undefined
              ? fmtLeft(st.doneAt - inc.createdAt)
              : st.status === 'breached'
                ? st.doneAt !== undefined
                  ? t('late {t}', { t: fmtLeft(st.doneAt - st.dueAt) })
                  : t('overdue {t}', { t: fmtLeft(s.now - st.dueAt) })
                : t('{t} left', { t: fmtLeft(st.dueAt - s.now) })}
          </b>
        </span>
      ))}
    </div>
  );
}

/** Small badge for lists: only when something is at risk or breached. */
export function SlaBadge({ inc }: { inc: Incident }) {
  const t = useT();
  const { stages } = useStages(inc);
  const sum = slaSummary(stages);
  if (sum !== 'breached' && sum !== 'at_risk') return null;
  return <span className={`badge ${sum === 'breached' ? 'badge-red solid' : 'badge-amber'} sla-badge`}>{sum === 'breached' ? t('SLA breached') : t('SLA at risk')}</span>;
}

/** The playbook's steps with tick boxes; who ticked and when is kept on the incident. */
export function Checklist({ inc }: { inc: Incident }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const me = currentUser(s);
  const list = inc.checklist ?? [];
  if (!list.length) return null;
  const book = pickPlaybook(s.playbooks, inc);
  const done = list.filter((x) => x.doneAt).length;
  const allowed = can(me.role, 'evidence.add') && !s.replay.active && !['closed', 'dismissed', 'duplicate'].includes(inc.status);
  return (
    <section className="step checklist">
      <h4>
        <ClipboardList size={14} /> {t('Playbook')} {book ? `· ${book.name}` : ''}{' '}
        <small className="muted">
          {done}/{list.length}
        </small>
      </h4>
      <ul>
        {list.map((st) => (
          <li key={st.id} className={st.doneAt ? 'done' : ''}>
            <label>
              <input
                type="checkbox"
                checked={!!st.doneAt}
                disabled={!allowed}
                onChange={(e) => dispatch({ type: 'setStep', incidentId: inc.id, stepId: st.id, done: e.target.checked })}
              />
              <span>
                {st.title}
                {st.role && <small className="muted"> · {t(st.role)}</small>}
                {st.detail && <small className="muted sub">{st.detail}</small>}
                {st.doneAt && (
                  <small className="muted sub">
                    {t('Done by {who}', { who: st.by ?? '—' })} ·{' '}
                    {new Date(st.doneAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })}
                  </small>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
