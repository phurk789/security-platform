import { describe, expect, it } from 'vitest';
import { liveVideoOf, reportLiveVideo, type LiveVideoStatus } from './liveVideo';

const lost: LiveVideoStatus = { phase: 'reconnecting', attempt: 3, maxRetries: 5, message: { main: 'Video link lost.', sub: 'Reconnecting (attempt 3 of 5)…' } };

describe('live video status shared by device', () => {
  it('keeps what the player reports and forgets it when the player goes', () => {
    const player = {};
    reportLiveVideo('UGV-01', player, lost);
    expect(liveVideoOf('UGV-01')).toEqual(lost);
    expect(liveVideoOf('UGV-02')).toBeUndefined();
    reportLiveVideo('UGV-01', player, null);
    expect(liveVideoOf('UGV-01')).toBeUndefined();
  });

  it("does not let an old player's clear-up wipe the new player's report (SD/HD switch)", () => {
    const oldPlayer = {};
    const newPlayer = {};
    reportLiveVideo('UGV-01', oldPlayer, lost);
    reportLiveVideo('UGV-01', newPlayer, { ...lost, phase: 'connecting', attempt: 0 });
    reportLiveVideo('UGV-01', oldPlayer, null);
    expect(liveVideoOf('UGV-01')?.phase).toBe('connecting');
    reportLiveVideo('UGV-01', newPlayer, null);
    expect(liveVideoOf('UGV-01')).toBeUndefined();
  });
});
