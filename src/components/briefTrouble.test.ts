import { describe, expect, it } from 'vitest';
import { briefTrouble, troubleCountdown } from './briefTrouble';
import { CHALLENGES } from '../sim/challenges';
import { INCIDENT_BRIEFS } from '../sim/incidents';
import type { Challenge } from '../sim/challenge';

const nameOf = (id: string) => (id === 's3' ? 'S3, one region' : `The ${id}`);
const base = CHALLENGES[0]!;
const withFaults = (faults: Challenge['faults']): Challenge => ({ ...base, faults });

describe('the trouble a brief promises', () => {
  it('is nothing for a brief with no faults', () => {
    expect(briefTrouble(withFaults(undefined), nameOf)).toBeNull();
    expect(briefTrouble(withFaults([]), nameOf)).toBeNull();
  });

  it('is the first fault to land, whatever order the brief lists them in', () => {
    const t = briefTrouble(
      withFaults([
        { atMs: 30_000, action: 'inject', nodeId: 'api', kind: 'slow' },
        { atMs: 12_000, action: 'clear', nodeId: 'db' },
        { atMs: 20_000, action: 'inject', nodeId: 'db', kind: 'crash' },
      ]),
      nameOf,
    );
    expect(t).toEqual({ atMs: 20_000, what: 'The db goes down', noun: 'Outage' });
  });

  it('closes a label that has a comma in it before the verb', () => {
    const s3 = INCIDENT_BRIEFS.find((b) => b.id === 'incident-s3-2017')!;
    expect(briefTrouble(s3, nameOf)?.what).toBe('S3, one region, goes down');
  });

  it('has words for every brief that ships with faults', () => {
    for (const b of [...CHALLENGES, ...INCIDENT_BRIEFS]) {
      if (!b.faults?.some((f) => f.action === 'inject' || f.action === 'cut')) continue;
      expect(briefTrouble(b, nameOf), b.id).not.toBeNull();
    }
  });

  it('counts down in whole seconds, rounded up, and stops once it lands', () => {
    const t = { atMs: 20_000, what: 'x', noun: 'Outage' };
    expect(troubleCountdown(t, 0)).toEqual({ noun: 'Outage', seconds: 20 });
    expect(troubleCountdown(t, 5_500)).toEqual({ noun: 'Outage', seconds: 15 });
    expect(troubleCountdown(t, 19_999)).toEqual({ noun: 'Outage', seconds: 1 });
    expect(troubleCountdown(t, 20_000)).toBeNull();
    expect(troubleCountdown(t, null)).toBeNull();
    expect(troubleCountdown(null, 0)).toBeNull();
  });
});
