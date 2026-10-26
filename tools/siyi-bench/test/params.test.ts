import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffParams, parseParamFile, sameValue } from '../params';

const roverFile = resolve(__dirname, '../../../deploy/vehicle/tracked-ugv-rover.param');

describe('parameter file', () => {
  it('parses the tracked UGV file and flags CONFIRM lines', () => {
    const params = parseParamFile(readFileSync(roverFile, 'utf8'));
    const byName = new Map(params.map((p) => [p.name, p]));
    expect(byName.get('FRAME_CLASS')?.value).toBe(1);
    expect(byName.get('FS_ACTION')?.value).toBe(2);
    expect(byName.get('FS_TIMEOUT')?.value).toBe(1.5);
    expect(byName.get('MOT_THR_MAX')?.value).toBe(40);
    expect(byName.get('SERIAL1_PROTOCOL')?.confirm).toBe(false); // port map confirmed on the bench
    expect(byName.get('BRD_SER1_RTSCTS')?.value).toBe(0);
    expect(byName.get('MAV2_OPTIONS')?.value).toBe(4); // ignore REQUEST_DATA_STREAM from other GCSs
    expect(byName.get('SERVO1_TRIM')?.confirm).toBe(true);
    expect(byName.get('FS_THR_VALUE')?.confirm).toBe(true);
    expect(byName.get('FS_ACTION')?.confirm).toBe(false);
    expect(params.every((p) => Number.isFinite(p.value))).toBe(true);
  });

  it('rejects malformed lines with the line number', () => {
    expect(() => parseParamFile('FRAME_CLASS,1\nBROKEN_LINE\n')).toThrow(/line 2/);
  });

  it('compares float32 values with a tolerance', () => {
    expect(sameValue(1.5, Math.fround(1.5))).toBe(true);
    expect(sameValue(0.5, Math.fround(0.5000001))).toBe(true);
    expect(sameValue(40, 41)).toBe(false);
  });

  it('reports match, mismatch and missing', () => {
    const expected = parseParamFile('FS_ACTION,2\nMOT_THR_MAX,40\nFS_TIMEOUT,1.5\n');
    const diffs = diffParams(expected, new Map([['FS_ACTION', 2], ['MOT_THR_MAX', 100]]));
    expect(diffs.map((d) => [d.name, d.kind])).toEqual([
      ['FS_ACTION', 'match'],
      ['MOT_THR_MAX', 'mismatch'],
      ['FS_TIMEOUT', 'missing'],
    ]);
    expect(diffs[0].severity).toBe('info');
  });
});
