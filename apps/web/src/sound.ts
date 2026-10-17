// Booth sound: a chime for a new alert, a blip when a command is confirmed, a warning tone for
// a failsafe stop, and the loudhailer announcement spoken aloud (Web Speech). Off by default;
// the presenter's toggle is the user gesture that unlocks audio. Nothing is loaded from the
// network: tones are synthesised.
import { useSyncExternalStore } from 'react';

const KEY = 'ps-sound';
const listeners = new Set<() => void>();
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
})();
let ctx: AudioContext | null = null;

function audio() {
  if (typeof AudioContext === 'undefined') return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function soundEnabled() {
  return enabled;
}

export function setSound(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* keep for this page */
  }
  if (on) {
    audio();
    blip();
  } else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  listeners.forEach((l) => l());
}

export function useSound() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => enabled,
    () => enabled,
  );
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = 'sine', gain = 0.18) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, a.currentTime + at);
  g.gain.exponentialRampToValueAtTime(gain, a.currentTime + at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + at);
  o.stop(a.currentTime + at + dur + 0.05);
}

/** New alert: two rising notes. */
export function chime() {
  if (!enabled) return;
  tone(660, 0, 0.18);
  tone(990, 0.16, 0.28);
}

/** Command confirmed / UI acknowledgement. */
export function blip() {
  if (!enabled) return;
  tone(1320, 0, 0.09, 'triangle', 0.12);
}

/** Failsafe or link loss: descending buzz. */
export function warn() {
  if (!enabled) return;
  tone(440, 0, 0.22, 'square', 0.1);
  tone(330, 0.24, 0.3, 'square', 0.1);
}

/** The loudhailer preset, read aloud in the language it is written in. */
export function speak(text: string) {
  if (!enabled || typeof speechSynthesis === 'undefined' || !text.trim()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = /[฀-๿]/.test(text) ? 'th-TH' : 'en-US';
  u.rate = 0.95;
  u.volume = 1;
  const voices = speechSynthesis.getVoices();
  const v = voices.find((x) => x.lang.replace('_', '-').toLowerCase().startsWith(u.lang.slice(0, 2).toLowerCase()));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
