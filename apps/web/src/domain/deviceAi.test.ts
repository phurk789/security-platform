import { describe, expect, it } from 'vitest';
import type { Device } from '@13store/shared';
import { aiSources, aiWaiting, calibrationReadiness } from './deviceAi';

const dev = (id: string, extra: Partial<Device> = {}) => ({ id, ...extra }) as Device;

describe('AI on a device in the console', () => {
  it('draws boxes from an AI box job, the device own analytics, and camera AIs that follow it', () => {
    const ugv = dev('UGV-01');
    const follower = dev('UGV-01-AI', { follows: 'UGV-01' });
    const other = dev('CCTV-01', { follows: 'UGV-02' });
    const all = { [ugv.id]: ugv, [follower.id]: follower, [other.id]: other };
    expect(aiSources(ugv, all)).toEqual(['UGV-01-AI']);
    expect(aiSources({ ...ugv, ai: { on: true, state: 'assigned', box: 'jetson' } }, all)).toEqual(['UGV-01', 'UGV-01-AI']);
    expect(aiSources(dev('UGV-02', { analytics: { provider: 'edge-vision', running: true, updatedAt: 1 } }), {})).toEqual(['UGV-02']);
    expect(aiSources(undefined, all)).toEqual([]);
  });

  it('says why AI that is switched on is not running yet', () => {
    expect(aiWaiting(dev('A', { ai: { on: true, state: 'no_box' } }))).toBe('No AI box connected');
    expect(aiWaiting(dev('A', { ai: { on: true, state: 'full' } }))).toBe('All AI boxes are busy');
    expect(aiWaiting(dev('A', { ai: { on: true, state: 'no_video' } }))).toBe('No video for the AI');
    expect(aiWaiting(dev('A', { ai: { on: true, state: 'assigned', box: 'b' } }))).toBeUndefined();
    expect(aiWaiting(dev('A', { ai: { on: false, state: 'full' } }))).toBeUndefined();
    expect(aiWaiting(dev('A'))).toBeUndefined();
  });

  it('is ready to calibrate distance only with one person in view and their feet in the picture', () => {
    const person = (bbox: number[]) => ({ type: 'person', bbox });
    expect(calibrationReadiness(undefined)).toBe('none');
    expect(calibrationReadiness([{ type: 'motion', bbox: [0.1, 0.1, 0.2, 0.2] }])).toBe('none');
    expect(calibrationReadiness([person([0.4, 0.3, 0.1, 0.4])])).toBe('ready');
    expect(calibrationReadiness([{ type: 'intrusion', bbox: [0.4, 0.3, 0.1, 0.4] }])).toBe('ready');
    expect(calibrationReadiness([person([0.4, 0.3, 0.1, 0.4]), person([0.1, 0.3, 0.1, 0.4])])).toBe('many');
    expect(calibrationReadiness([person([0.4, 0.4, 0.1, 0.6])])).toBe('cut');
  });
});
