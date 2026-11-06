// The AI switch on a camera view: an AI box analyses this device's video while it is on. The
// server picks the box and keeps it on until someone switches it off; the device update coming
// back over the live connection moves the switch (so every console shows the same state).
import { useState } from 'react';
import { ScanEye } from 'lucide-react';
import type { Device } from '@13store/shared';
import { can, currentUser } from '../domain/policy';
import { aiWaiting } from '../domain/deviceAi';
import { useT } from '../i18n';
import { useStore } from '../store';
import './ai-boxes.css';

export function AiSwitch({ d, hud }: { d: Device; hud?: boolean }) {
  const { s, session } = useStore();
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Real devices only (the offline demo has no AI boxes), and never while replaying.
  if (!session || s.replay.active) return null;
  const me = currentUser(s);
  const allowed = can(me.role, 'camera.control');
  const on = !!d.ai?.on;
  const waiting = aiWaiting(d);
  const flip = async () => {
    setBusy(true);
    try {
      await session.setAi(d.id, !on);
    } finally {
      setBusy(false);
    }
  };
  const title = !allowed
    ? t('Your role cannot switch the AI.')
    : `${on ? t('Switch AI off for {id}', { id: d.id }) : t('Switch AI on for {id}', { id: d.id })}${d.ai?.by ? ` · ${t('Last switched by {name}', { name: d.ai.by })}` : ''}`;
  // On the cockpit HUD it is the knob at the end of the AI row, which already says what the AI is doing.
  if (hud)
    return (
      <button
        type="button"
        className={`ai-switch is-hud${on ? ' on' : ''}${waiting ? ' waiting' : ''}`}
        role="switch"
        aria-checked={on}
        aria-label={`AI · ${d.id}`}
        disabled={!allowed || busy}
        onClick={() => void flip()}
        title={title}
      >
        <span className="ai-switch-knob" aria-hidden="true" />
      </button>
    );
  return (
    <button
      type="button"
      className={`ai-switch${on ? ' on' : ''}${waiting ? ' waiting' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={!allowed || busy}
      onClick={() => void flip()}
      title={title}
    >
      <ScanEye size={14} aria-hidden="true" />
      <span className="ai-switch-text">{on ? t('AI on') : t('AI off')}</span>
      <span className="ai-switch-knob" aria-hidden="true" />
      {waiting && <small>{t(waiting)}</small>}
    </button>
  );
}
