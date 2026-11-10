import { describe, expect, it } from 'vitest';
import { tr, type T } from '../i18n';
import { lastSeenText } from './lastSeen';

const th: T = (en, vars) => tr(en, vars, 'th');
const now = Date.UTC(2026, 10, 10, 6, 0, 0);

describe('last seen on the Devices page', () => {
  it('says a registered device never connected, not hundreds of thousands of hours ago', () => {
    expect(lastSeenText(th, 0, now)).toBe('ยังไม่เคยเชื่อมต่อ');
  });

  it('says just now for the last 10 seconds, then the age', () => {
    expect(lastSeenText(th, now - 3_000, now)).toBe('เมื่อสักครู่');
    expect(lastSeenText(th, now - 90 * 60_000, now)).not.toBe('เมื่อสักครู่');
    expect(lastSeenText(th, now - 90 * 60_000, now)).toMatch(/1/);
  });
});
