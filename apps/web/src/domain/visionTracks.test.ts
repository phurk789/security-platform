import { describe, expect, it } from 'vitest';
import { BOXES_FRESH_MS, freshTracks, placeBox, type LiveTracks, type Rect } from './visionTracks';

/** Pixel positions to the nearest hundredth (the maths leaves float dust like 120.00000000000003). */
const px = (r: Rect | null) => r && { left: +r.left.toFixed(2), top: +r.top.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) };

describe('live AI boxes', () => {
  it('places a box on video that covers a wider view (top and bottom cropped)', () => {
    // 1280×720 frame on a 1600×600 view: scale 1.25, frame 1600×900, 150 px cut top and bottom.
    expect(px(placeBox([0.25, 0.5, 0.5, 0.25], 1280, 720, 1600, 600))).toEqual({ left: 400, top: 300, width: 800, height: 225 });
    // A box in the cropped top strip is not shown.
    expect(placeBox([0.1, 0, 0.2, 0.1], 1280, 720, 1600, 600)).toBeNull();
    // A box half in the crop is trimmed to the visible part.
    // y from 0.1 to 0.3 of 900 px, minus the 150 px cut: −60 (trimmed to 0) to 120.
    expect(px(placeBox([0, 0.1, 0.1, 0.2], 1280, 720, 1600, 600))).toEqual({ left: 0, top: 0, width: 160, height: 120 });
  });

  it('places a box on video that covers a taller view (sides cropped), and refuses empty sizes', () => {
    // 16:9 frame on a square 900×900 view: scale 1, frame 1600 wide, 350 px cut each side.
    const r = placeBox([0.5, 0, 0.1, 1], 1600, 900, 900, 900)!;
    expect(r.left).toBeCloseTo(450);
    expect(r.width).toBeCloseTo(160);
    expect(r.height).toBeCloseTo(900);
    expect(placeBox([0, 0, 1, 1], 0, 900, 900, 900)).toBeNull();
  });

  it('shows the freshest boxes of a vehicle and its camera AI, and none once they are stale', () => {
    const t = (deviceId: string, receivedAt: number): LiveTracks => ({ deviceId, at: receivedAt, receivedAt, boxes: [{ type: 'person', confidence: 0.9, bbox: [0, 0, 0.1, 0.1] }] });
    const all = new Map([
      ['UGV-01-AI', t('UGV-01-AI', 1000)],
      ['UGV-01', t('UGV-01', 900)],
      ['CCTV-02', t('CCTV-02', 1100)],
    ]);
    expect(freshTracks(all, ['UGV-01', 'UGV-01-AI'], 1200)?.deviceId).toBe('UGV-01-AI');
    expect(freshTracks(all, ['UGV-01', 'UGV-01-AI'], 1000 + BOXES_FRESH_MS)).toBeUndefined();
  });
});
