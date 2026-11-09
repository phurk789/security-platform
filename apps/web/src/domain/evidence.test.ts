import { describe, expect, it } from 'vitest';
import type { Detection, Evidence } from '@13store/shared';
import { detectionWindow, evidenceShots, framePoints, isImage, mergeDetections, shotPaths, splitSource, summarizeShots } from './evidence';
import { tr } from '../i18n';

const ev = (id: string, capturedAt: number, over: Partial<Evidence> = {}): Evidence => ({
  id,
  incidentId: 'INC-001',
  kind: 'snapshot',
  title: `UGV-01 AI · jetson-ai-01: Intrusion detected (person)`,
  source: 'UGV-01 AI · jetson-ai-01',
  capturedAt,
  recordedBy: 'UGV-01 AI · jetson-ai-01',
  simulated: false,
  mime: 'image/jpeg',
  ...over,
});
const det = (id: string, snapshotEvidenceId: string | undefined, over: Partial<Detection> = {}): Detection => ({
  id,
  at: 0,
  receivedAt: 0,
  type: 'intrusion',
  confidence: 0.9,
  source: 'UGV-01 AI · jetson-ai-01',
  deviceId: 'UGV-01',
  outcome: 'merged',
  incidentId: 'INC-001',
  snapshotEvidenceId,
  ...over,
});

describe('images of an incident', () => {
  it('shows stills and photos as pictures, notes, clips and non-image files as files', () => {
    expect(isImage({ kind: 'snapshot', mime: 'image/jpeg' })).toBe(true);
    expect(isImage({ kind: 'photo', mime: 'image/svg+xml' })).toBe(true);
    expect(isImage({ kind: 'snapshot' })).toBe(true);
    expect(isImage({ kind: 'note' })).toBe(false);
    expect(isImage({ kind: 'clip', mime: 'video/mp4' })).toBe(false);
    expect(isImage({ kind: 'photo', mime: 'application/pdf' })).toBe(false);
  });

  it('numbers the images oldest first and adds where, how far and how sure from their detections', () => {
    const files = [ev('EV-0105', 3000), ev('EV-0103', 1000), { ...ev('EV-0110', 2500), kind: 'note' as const }, ev('EV-0104', 2000)];
    const dets = [
      det('DET-1', 'EV-0103', { pos: { x: 10, y: 20 }, confidence: 0.82, attributes: { label: 'person', distanceM: 24.6 } }),
      det('DET-2', 'EV-0104', { pos: { x: 12, y: 21 }, attributes: { label: 'person' } }),
      det('DET-3', undefined, { pos: { x: 99, y: 99 } }),
    ];
    const shots = evidenceShots(files, dets);
    expect(shots.map((s) => [s.n, s.ev.id])).toEqual([
      [1, 'EV-0103'],
      [2, 'EV-0104'],
      [3, 'EV-0105'],
    ]);
    expect(shots[0]).toMatchObject({ pos: { x: 10, y: 20 }, distanceM: 24.6, confidence: 0.82, deviceId: 'UGV-01' });
    // A detection without a distance gives none; an image without a detection gives nothing at all.
    expect(shots[1].distanceM).toBeUndefined();
    expect(shots[2]).toMatchObject({ pos: undefined, confidence: undefined, deviceId: undefined });
  });

  it('keeps images taken in the same millisecond in id order', () => {
    expect(evidenceShots([ev('EV-0009', 5), ev('EV-0008', 5)], []).map((s) => s.ev.id)).toEqual(['EV-0008', 'EV-0009']);
  });
});

describe('where an image came from', () => {
  it('splits an AI box source into the vehicle and the box', () => {
    expect(splitSource('UGV-01 AI · jetson-ai-01')).toEqual({ device: 'UGV-01', box: 'jetson-ai-01' });
    expect(splitSource('CCTV-07 analytics')).toEqual({ device: 'CCTV-07 analytics' });
  });
});

describe('detections behind the images', () => {
  it('asks for the span from the oldest to the newest image, nothing without images', () => {
    expect(detectionWindow([ev('EV-2', 5000), ev('EV-1', 2000), { ...ev('EV-3', 9000), kind: 'note' }])).toEqual({ from: 2000, to: 5000 });
    expect(detectionWindow([{ ...ev('EV-3', 9000), kind: 'note' }])).toBeNull();
  });

  it('merges fetched and live detections once each, the live copy winning', () => {
    const merged = mergeDetections([det('DET-1', 'EV-1'), det('DET-2', 'EV-2')], [det('DET-2', 'EV-2', { confidence: 0.5 }), det('DET-3', 'EV-3')]);
    expect(merged.map((d) => d.id).sort()).toEqual(['DET-1', 'DET-2', 'DET-3']);
    expect(merged.find((d) => d.id === 'DET-2')?.confidence).toBe(0.5);
  });
});

describe('summary and map', () => {
  const shots = evidenceShots(
    [ev('EV-1', 1000), ev('EV-2', 2000), ev('EV-3', 3000), { ...ev('EV-4', 4000), source: 'CCTV-07 analytics' }],
    [
      det('D1', 'EV-1', { pos: { x: 0, y: 0 }, attributes: { distanceM: 17.2 } }),
      det('D2', 'EV-2', { pos: { x: 5, y: 0 }, attributes: { distanceM: 7.4 } }),
      det('D3', 'EV-3', { pos: { x: 9, y: 1 } }),
      det('D4', 'EV-4', { pos: { x: 50, y: 50 }, deviceId: 'CCTV-07' }),
    ],
  );

  it('gives the first and last time, the nearest distance and how many images are on the map', () => {
    expect(summarizeShots(shots)).toEqual({ first: 1000, last: 4000, nearestM: 7.4, placed: 4 });
    expect(summarizeShots([])).toEqual({ first: undefined, last: undefined, nearestM: undefined, placed: 0 });
  });

  it('draws one path per camera through the places it took its images, only with two or more', () => {
    expect(shotPaths(shots)).toEqual([
      {
        deviceId: 'UGV-01',
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 9, y: 1 },
        ],
      },
    ]);
  });

  it('frames the incident and every placed image', () => {
    expect(framePoints({ x: 1, y: 1 }, shots.slice(0, 2))).toEqual([
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
    expect(framePoints(undefined, [])).toEqual([]);
  });
});

describe('Thai on the Evidence page', () => {
  const th = (en: string, v?: Record<string, string | number>) => tr(en, v, 'th');
  it('has Thai for the new labels', () => {
    for (const en of ['Snapshots ({n})', 'Notes & files ({n})', 'Open full size', 'Seen by', 'AI box', 'Where it happened', 'Show all evidence on the map', 'Checksum matches', 'No position'])
      expect(th(en)).not.toBe(en);
    expect(th('about {m} m away', { m: 11.8 })).toBe('ห่างราว 11.8 ม.');
  });
});
