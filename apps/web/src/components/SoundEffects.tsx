// Plays booth sounds on state changes: a chime for a new alert, a blip when a command is
// confirmed by the vehicle, a warning for a failsafe stop, and the loudhailer preset read aloud.
import { useEffect, useRef } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useT } from '../i18n';
import { blip, chime, setSound, speak, useSound, warn } from '../sound';
import { useStore } from '../store';

export function SoundEffects() {
  const { s } = useStore();
  const on = useSound();
  const seen = useRef<{ incidents: Set<string>; cmds: Set<string>; failsafe: Set<string>; said: Map<string, string> } | null>(null);
  useEffect(() => {
    const first = !seen.current;
    seen.current ??= { incidents: new Set(), cmds: new Set(), failsafe: new Set(), said: new Map() };
    const m = seen.current;
    for (const i of s.incidents) {
      if (!m.incidents.has(i.id)) {
        m.incidents.add(i.id);
        if (!first && i.status === 'new' && on) chime();
      }
    }
    for (const c of s.commands) {
      if (c.status === 'succeeded' && !m.cmds.has(c.id)) {
        m.cmds.add(c.id);
        if (!first && on) blip();
      }
    }
    for (const [id, at] of Object.entries(s.failsafeAt)) {
      const key = `${id}:${at ?? ''}`;
      if (at !== undefined && !m.failsafe.has(key)) {
        m.failsafe.add(key);
        if (!first && on) warn();
      }
    }
    for (const d of Object.values(s.devices)) {
      const text = d.gimbal?.announcing ?? '';
      if (text && m.said.get(d.id) !== text) {
        m.said.set(d.id, text);
        if (!first && on) speak(text);
      }
      if (!text) m.said.delete(d.id);
    }
  }, [s.incidents, s.commands, s.failsafeAt, s.devices, on]);
  return null;
}

/** Top-bar toggle. Turning sound on is the user gesture that unlocks audio in the browser. */
export function SoundToggle() {
  const on = useSound();
  const t = useT();
  return (
    <button
      className={`appearance-toggle${on ? ' on' : ''}`}
      onClick={() => setSound(!on)}
      aria-pressed={on}
      title={on ? t('Sound on (alerts, confirmations, announcements)') : t('Sound off')}
    >
      {on ? <Volume2 size={16} /> : <VolumeX size={16} />}
    </button>
  );
}
