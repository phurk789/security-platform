import { describe, expect, it } from 'vitest';
import { edgeOriginOf } from '../views/Admin';

describe('edgeOriginOf (Allowed video sources form)', () => {
  it('keeps scheme, host and port', () => {
    expect(edgeOriginOf('http://192.168.10.50:8889')).toBe('http://192.168.10.50:8889');
    expect(edgeOriginOf('  https://edge.example.com  ')).toBe('https://edge.example.com');
  });

  it('accepts a pasted WHEP link', () => {
    expect(edgeOriginOf('http://192.168.10.50:8889/ugv-01/whep')).toBe('http://192.168.10.50:8889');
  });

  it('refuses what is not an http(s) URL', () => {
    for (const bad of ['192.168.10.50:8889', 'rtsp://192.168.144.25:8554/main.264', 'ftp://x', '', 'not a url']) expect(edgeOriginOf(bad)).toBeNull();
  });
});
