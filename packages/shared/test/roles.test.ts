// Roles are levels: a supervisor can do everything a dispatcher and an operator can, an
// administrator everything a supervisor can. Auditors and field responders stay narrow.
import { describe, expect, it } from 'vitest';
import { MATRIX, can } from '../src';

const has = (role: keyof typeof MATRIX, others: (keyof typeof MATRIX)[]) => others.flatMap((o) => MATRIX[o]).filter((a) => !MATRIX[role].includes(a));

describe('role levels', () => {
  it('supervisors include dispatchers and operators; administrators include supervisors', () => {
    expect(has('supervisor', ['dispatcher', 'operator'])).toEqual([]);
    expect(has('admin', ['supervisor'])).toEqual([]);
    expect(can('supervisor', 'device.command') && can('supervisor', 'mission.accept')).toBe(true);
    expect(can('admin', 'mission.approve') && can('admin', 'device.command') && can('admin', 'admin.users')).toBe(true);
  });

  it('keeps the lower and side roles narrow', () => {
    expect(can('dispatcher', 'mission.approve') || can('dispatcher', 'device.command')).toBe(false);
    expect(can('operator', 'mission.approve') || can('operator', 'incident.verify')).toBe(false);
    expect(can('supervisor', 'admin.users')).toBe(false);
    expect(can('auditor', 'media.view') && can('auditor', 'audit.view')).toBe(true);
    expect(can('auditor', 'device.command') || can('auditor', 'incident.edit')).toBe(false);
    expect(MATRIX.responder).toEqual(['incident.create', 'field.update', 'evidence.view', 'evidence.add']);
  });
});
