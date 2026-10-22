// Parameter file parsing and comparison for the SIYI bench probe.
// Expected values come from deploy/vehicle/tracked-ugv-rover.param (Mission Planner format).

export interface ExpectedParam {
  name: string;
  value: number;
  /** The file marks this line CONFIRM: the value depends on the board or vehicle and must be measured. */
  confirm: boolean;
  line: number;
  note: string;
}

export type DiffKind = 'match' | 'mismatch' | 'missing';
export type Severity = 'critical' | 'warning' | 'info';

export interface ParamDiff {
  name: string;
  expected: number;
  actual: number | undefined;
  kind: DiffKind;
  severity: Severity;
  confirm: boolean;
  note: string;
}

/** Parse `NAME,VALUE  # comment` lines; blank lines and full-line comments are skipped. */
export function parseParamFile(text: string): ExpectedParam[] {
  const out: ExpectedParam[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const hash = raw.indexOf('#');
    const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const note = hash >= 0 ? raw.slice(hash + 1).trim() : '';
    if (!body) return;
    const [name, value] = body.split(',').map((s) => s.trim());
    const num = Number(value);
    if (!name || value === undefined || !Number.isFinite(num)) {
      throw new Error(`Bad parameter line ${i + 1}: ${raw.trim()}`);
    }
    out.push({ name: name.toUpperCase(), value: num, confirm: /\bCONFIRM\b/.test(note), line: i + 1, note });
  });
  return out;
}

/** PARAM_VALUE carries float32, so compare with a relative tolerance. */
export function sameValue(expected: number, actual: number, tolerance = 1e-4): boolean {
  return Math.abs(expected - actual) <= tolerance * Math.max(1, Math.abs(expected));
}

export function diffParams(expected: ExpectedParam[], actual: ReadonlyMap<string, number>): ParamDiff[] {
  return expected.map((p) => {
    const value = actual.get(p.name);
    const kind: DiffKind = value === undefined ? 'missing' : sameValue(p.value, value) ? 'match' : 'mismatch';
    return {
      name: p.name,
      expected: p.value,
      actual: value,
      kind,
      severity: classifyParamDiff(p, kind),
      confirm: p.confirm,
      note: p.note,
    };
  });
}

/**
 * Decide how serious a parameter difference is for the bench report.
 * A `critical` result makes the whole bench report fail.
 */
export function classifyParamDiff(p: ExpectedParam, kind: DiffKind): Severity {
  // TODO(user): decide which differences block the test. Questions to answer:
  //   - Which parameters are safety-critical (failsafes, arming, output limits, mode switch)?
  //   - Should a CONFIRM line that differs be `info` (expected until measured) or `warning`?
  //   - Is a missing parameter critical (wrong firmware or vehicle type) or just a warning?
  // Neutral default until then: any difference is a warning, matches are info.
  void p;
  return kind === 'match' ? 'info' : 'warning';
}
