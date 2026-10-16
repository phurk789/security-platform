// Thai / English UI text. English strings are the keys; Thai lives in i18n-th.ts.
// Missing Thai falls back to English, so a new string never shows a raw key.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Role } from '@13store/shared';
import { TH } from './i18n-th';

export type Lang = 'th' | 'en';
type Vars = Record<string, string | number | undefined>;

const KEY = 'ps.lang';

function loadLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'th') return v;
  } catch {
    /* storage blocked */
  }
  return 'th';
}

let current: Lang = loadLang();

/** Current language, for code outside React (e.g. toasts built in event handlers). */
export function currentLang() {
  return current;
}

function fill(s: string, vars?: Vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
}

/** Translate an English UI string. Use `{name}` placeholders for values. */
export function tr(en: string, vars?: Vars, lang: Lang = current): string {
  return fill(lang === 'th' ? (TH[en] ?? en) : en, vars);
}

export type T = (en: string, vars?: Vars) => string;

interface LangValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: T;
}

const LangCtx = createContext<LangValue>({ lang: current, setLang: () => {}, t: (en, v) => tr(en, v) });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  const setLang = useCallback((l: Lang) => {
    current = l;
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* storage blocked: session only */
    }
    setLangState(l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<LangValue>(() => ({ lang, setLang, t: (en, v) => tr(en, v, lang) }), [lang, setLang]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export function useLang() {
  return useContext(LangCtx);
}

export function useT(): T {
  return useContext(LangCtx).t;
}

/** "8s" / "8 วินาที" — a duration without "ago". */
export function age(ms: number, lang: Lang = current) {
  const s = Math.max(0, Math.round(ms / 1000));
  const th = lang === 'th';
  if (s < 60) return th ? `${s} วินาที` : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return th ? `${m} นาที` : `${m} min`;
  const h = Math.floor(m / 60);
  return th ? `${h} ชม. ${m % 60} นาที` : `${h} h ${m % 60} min`;
}

/** "2 min ago" / "2 นาทีที่แล้ว". */
export function ago(ms: number, lang: Lang = current) {
  return lang === 'th' ? `${age(ms, lang)}ที่แล้ว` : `${age(ms, lang)} ago`;
}

const ROLE_TH: Record<Role, string> = {
  dispatcher: 'เจ้าหน้าที่รับแจ้ง',
  supervisor: 'หัวหน้าเวร',
  operator: 'ผู้ควบคุมอุปกรณ์',
  responder: 'เจ้าหน้าที่ภาคสนาม',
  auditor: 'ผู้ตรวจสอบ',
  admin: 'ผู้ดูแลระบบ',
};
const ROLE_EN: Record<Role, string> = {
  dispatcher: 'Dispatcher',
  supervisor: 'Supervisor',
  operator: 'Operator',
  responder: 'Field Responder',
  auditor: 'Auditor',
  admin: 'Administrator',
};

export function roleLabel(role: string, lang: Lang = current) {
  const r = role as Role;
  return (lang === 'th' ? ROLE_TH[r] : ROLE_EN[r]) ?? role;
}

/** TH | EN segmented control. */
export function LangToggle({ className = '' }: { className?: string }) {
  const { lang, setLang } = useLang();
  return (
    <div className={`seg lang-toggle ${className}`} role="group" aria-label="Language / ภาษา">
      <button type="button" className={lang === 'th' ? 'on' : ''} aria-pressed={lang === 'th'} onClick={() => setLang('th')}>
        TH
      </button>
      <button type="button" className={lang === 'en' ? 'on' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
        EN
      </button>
    </div>
  );
}
