import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseEnvMode } from '../src/config';

describe('ENV_MODE', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { ENV_MODE: process.env.ENV_MODE, MEDIA_SECRET: process.env.MEDIA_SECRET };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to demo when unset or empty', () => {
    expect(parseEnvMode(undefined)).toBe('demo');
    expect(parseEnvMode('')).toBe('demo');
    expect(parseEnvMode('  ')).toBe('demo');
  });

  it('accepts demo and pilot, ignoring case and spaces', () => {
    expect(parseEnvMode('demo')).toBe('demo');
    expect(parseEnvMode('pilot')).toBe('pilot');
    expect(parseEnvMode(' Pilot ')).toBe('pilot');
  });

  it('refuses any other value instead of running as demo', () => {
    for (const bad of ['production', 'prod', 'pilto', 'sandbox']) {
      expect(() => parseEnvMode(bad)).toThrow(/ENV_MODE must be "demo" or "pilot"/);
    }
  });

  it('stops loadConfig on a typo, so demo users are never seeded by mistake', () => {
    process.env.ENV_MODE = 'production';
    process.env.MEDIA_SECRET = 'x'.repeat(32);
    expect(() => loadConfig()).toThrow(/ENV_MODE/);
  });

  it('still requires MEDIA_SECRET in pilot', () => {
    process.env.ENV_MODE = 'pilot';
    delete process.env.MEDIA_SECRET;
    expect(() => loadConfig()).toThrow(/MEDIA_SECRET/);
    process.env.MEDIA_SECRET = 'x'.repeat(32);
    expect(loadConfig().env).toBe('pilot');
  });
});
