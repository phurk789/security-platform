import { describe, expect, it } from 'vitest';
import { displayNumber, matchesUnit } from './liquidPresentation';

describe('Liquid Glass display helpers', () => {
  const unit = { id: 'UGV-01', model: 'Small electric UGV · ArduPilot Rover', kind: 'ugv' as const };
  it('matches ID, model and multiple tokens without case sensitivity', () => {
    expect(matchesUnit(unit, 'ugv-01')).toBe(true);
    expect(matchesUnit(unit, '  ROVER ugv ')).toBe(true);
    expect(matchesUnit(unit, 'drone')).toBe(false);
    expect(matchesUnit(unit, '')).toBe(true);
  });
  it('never formats an unknown or invalid value as zero', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity]) expect(displayNumber(value)).toBe('—');
    expect(displayNumber(0, 1)).toBe('0.0');
    expect(displayNumber(-1, 0, 0, 100)).toBe('—');
    expect(displayNumber(101, 0, 0, 100)).toBe('—');
    expect(displayNumber(94.04, 1, 0, 100)).toBe('94.0');
  });
});
