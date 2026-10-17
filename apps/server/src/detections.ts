// AI / sensor detections: what an analytics system, thermal camera or NVR reports, and the
// per-organisation rules that decide whether a detection becomes an incident, is only logged,
// or is ignored. Pure functions here; storage and incident creation live in platform.ts.
import { DEFAULT_DETECTION_RULES, DETECTION_LABEL, DETECTION_TYPES, type DetectionInput, type DetectionRule, type DetectionType, type Point } from '@13store/shared';

const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SEVERITIES = ['low', 'medium', 'high'] as const;
const ACTIONS = ['incident', 'log', 'ignore'] as const;

/** Validates a rule list from an administrator. Throws a readable message on the first problem. */
export function validateRules(input: unknown): DetectionRule[] {
  if (!Array.isArray(input)) throw new Error('detection.rules must be a list.');
  if (input.length > 50) throw new Error('At most 50 detection rules.');
  const out: DetectionRule[] = [];
  const ids = new Set<string>();
  input.forEach((raw, i) => {
    const r = raw as Record<string, unknown>;
    const where = `Rule ${i + 1}`;
    if (!r || typeof r !== 'object') throw new Error(`${where} must be an object.`);
    if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) throw new Error(`${where}: id must be 1–32 letters, digits, - or _.`);
    if (ids.has(r.id)) throw new Error(`${where}: duplicate id ${r.id}.`);
    ids.add(r.id);
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80) throw new Error(`${where}: name is required (max 80 characters).`);
    if (!Array.isArray(r.types) || !r.types.length || r.types.some((t) => !DETECTION_TYPES.includes(t as DetectionType)))
      throw new Error(`${where}: types must list one or more of ${DETECTION_TYPES.join(', ')}.`);
    const conf = r.minConfidence ?? 0;
    if (typeof conf !== 'number' || !(conf >= 0 && conf <= 1)) throw new Error(`${where}: minConfidence must be between 0 and 1.`);
    if (r.minTemperatureC !== undefined && (typeof r.minTemperatureC !== 'number' || !(r.minTemperatureC >= -50 && r.minTemperatureC <= 2000)))
      throw new Error(`${where}: minTemperatureC must be between -50 and 2000.`);
    if (r.zones !== undefined && (!Array.isArray(r.zones) || r.zones.length > 20 || r.zones.some((z) => typeof z !== 'string' || !z.trim() || z.length > 40)))
      throw new Error(`${where}: zones must be up to 20 zone names.`);
    if (r.hours !== undefined) {
      const h = r.hours as Record<string, unknown>;
      if (!h || typeof h.from !== 'string' || typeof h.to !== 'string' || !HHMM.test(h.from) || !HHMM.test(h.to)) throw new Error(`${where}: hours need from and to as HH:MM.`);
    }
    if (!ACTIONS.includes(r.action as (typeof ACTIONS)[number])) throw new Error(`${where}: action must be incident, log or ignore.`);
    const severity = (r.severity ?? 'medium') as (typeof SEVERITIES)[number];
    if (!SEVERITIES.includes(severity)) throw new Error(`${where}: severity must be low, medium or high.`);
    const cd = Number(r.cooldownS ?? 0);
    if (!Number.isInteger(cd) || cd < 0 || cd > 86_400) throw new Error(`${where}: cooldownS must be a whole number of seconds up to 86400.`);
    out.push({
      id: r.id,
      name: r.name.trim(),
      enabled: r.enabled !== false,
      types: [...new Set(r.types as DetectionType[])],
      minConfidence: conf,
      minTemperatureC: r.minTemperatureC as number | undefined,
      zones: r.zones ? (r.zones as string[]).map((z) => z.trim()) : undefined,
      hours: r.hours ? { from: (r.hours as { from: string }).from, to: (r.hours as { to: string }).to } : undefined,
      action: r.action as DetectionRule['action'],
      severity,
      cooldownS: cd,
    });
  });
  return out;
}

export function defaultRules(): DetectionRule[] {
  return DEFAULT_DETECTION_RULES.map((r) => ({ ...r, types: [...r.types] }));
}

/** Local HH:MM of a timestamp in a time zone (falls back to UTC on an unknown zone). */
export function localMinutes(at: number, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  }
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

function inHours(at: number, hours: DetectionRule['hours'], timezone: string) {
  if (!hours) return true;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const from = toMin(hours.from);
  const to = toMin(hours.to);
  const now = localMinutes(at, timezone);
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The first enabled rule the detection satisfies, or none (then the detection is only logged). */
export function matchRule(
  rules: DetectionRule[],
  d: { type: DetectionType; confidence: number; zone?: string; at: number; attributes?: DetectionInput['attributes'] },
  timezone: string,
): DetectionRule | undefined {
  return rules.find((r) => {
    if (!r.enabled || !r.types.includes(d.type)) return false;
    if (d.confidence < r.minConfidence) return false;
    if (r.minTemperatureC !== undefined && d.type === 'thermal_hotspot') {
      const t = d.attributes?.temperatureC;
      if (typeof t !== 'number' || t < r.minTemperatureC) return false;
    }
    if (r.zones?.length && (!d.zone || !r.zones.includes(d.zone))) return false;
    return inHours(d.at, r.hours, timezone);
  });
}

/** Cleans an incoming detection. Throws on an unusable one. */
export function sanitizeDetection(raw: unknown, now: number): DetectionInput & { confidence: number; at: number } {
  const d = raw as Record<string, unknown>;
  if (!d || typeof d !== 'object') throw new Error('Detection must be an object.');
  if (!DETECTION_TYPES.includes(d.type as DetectionType)) throw new Error(`type must be one of ${DETECTION_TYPES.join(', ')}.`);
  const confidence = d.confidence === undefined ? 1 : Number(d.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new Error('confidence must be between 0 and 1.');
  let at = d.at === undefined ? now : Number(d.at);
  if (!Number.isFinite(at)) throw new Error('at must be a timestamp in milliseconds.');
  // Clocks drift: accept up to a minute in the future and a week in the past.
  at = Math.min(at, now + 60_000);
  if (at < now - 7 * 86_400_000) throw new Error('at is more than 7 days old.');
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const pos = d.pos as Point | undefined;
  const snapshot = d.snapshot as { mime?: unknown; base64?: unknown } | undefined;
  if (
    snapshot &&
    (typeof snapshot.mime !== 'string' ||
      typeof snapshot.base64 !== 'string' ||
      !/^image\/(jpeg|png|webp|svg\+xml)$/.test(snapshot.mime) ||
      snapshot.base64.length > 6 * 1024 * 1024)
  )
    throw new Error('snapshot must be a JPEG, PNG, WebP or SVG image under 4 MB, base64 encoded.');
  const bbox = d.bbox as unknown[] | undefined;
  const attrs = (d.attributes ?? {}) as Record<string, unknown>;
  return {
    type: d.type as DetectionType,
    confidence,
    at,
    deviceId: str(d.deviceId, 32),
    source: str(d.source, 80),
    zone: str(d.zone, 40),
    place: str(d.place, 80),
    pos: pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Number(pos.x), y: Number(pos.y) } : undefined,
    bbox: Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === 'number' && n >= 0 && n <= 1) ? (bbox as [number, number, number, number]) : undefined,
    attributes: {
      temperatureC: typeof attrs.temperatureC === 'number' && Number.isFinite(attrs.temperatureC) ? Math.round(attrs.temperatureC * 10) / 10 : undefined,
      plate: str(attrs.plate, 16),
      count: Number.isInteger(attrs.count) && (attrs.count as number) >= 0 ? (attrs.count as number) : undefined,
      label: str(attrs.label, 60),
    },
    snapshot: snapshot ? { mime: snapshot.mime as string, base64: snapshot.base64 as string } : undefined,
    externalId: str(d.externalId, 80),
  };
}

/** Human title for an incident raised from a detection, e.g. "Thermal hotspot 84 °C". */
export function detectionTitle(d: { type: DetectionType; confidence: number; attributes?: DetectionInput['attributes'] }) {
  const label = d.attributes?.label ?? DETECTION_LABEL[d.type];
  if (d.type === 'thermal_hotspot' && d.attributes?.temperatureC !== undefined) return `${label} ${d.attributes.temperatureC} °C`;
  if (d.type === 'lpr' && d.attributes?.plate) return `${label} ${d.attributes.plate}`;
  if (d.type === 'crowd' && d.attributes?.count !== undefined) return `${label} of ${d.attributes.count}`;
  return `${label} detected`;
}

export function detectionDetail(d: {
  type: DetectionType;
  confidence: number;
  source: string;
  attributes?: DetectionInput['attributes'];
  bbox?: [number, number, number, number];
}) {
  const bits = [`${d.source}`, `confidence ${Math.round(d.confidence * 100)}%`];
  if (d.attributes?.temperatureC !== undefined) bits.push(`${d.attributes.temperatureC} °C`);
  if (d.attributes?.plate) bits.push(`plate ${d.attributes.plate}`);
  if (d.attributes?.count !== undefined) bits.push(`${d.attributes.count} people`);
  if (d.bbox) bits.push(`box ${d.bbox.map((n) => Math.round(n * 100)).join('/')}%`);
  return bits.join(' · ');
}
