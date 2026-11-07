import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';
import { CHALLENGES } from './challenges';
import { FIXED_DURING_CHALLENGE, evaluate } from './challenge';
import type { Challenge } from './challenge';
import type { SimSnapshot } from './types';

/**
 * What a brief has to carry to be one.
 *
 * Whether each brief can be lost and won is judge.test.ts's job, against the
 * check that hands out the pass. This file holds the parts that are not a
 * run: the copy, the locks and the live reading.
 */

describe('challenges', () => {
  it('every challenge names a preset that exists', () => {
    for (const c of CHALLENGES) {
      expect(
        PRESETS.some((p) => p.id === c.presetId),
        c.id,
      ).toBe(true);
    }
  });

  it('every brief teaches something once it is passed', () => {
    // The lesson is the reason this is not a puzzle. A brief that ends at
    // "passed" leaves the reader with a number that works here and nowhere
    // else.
    for (const c of CHALLENGES) {
      expect(c.lesson.length, `${c.id} lesson`).toBeGreaterThan(120);
      expect(c.hints.length, `${c.id} hints`).toBeGreaterThan(1);
    }
  });

  it('no hint gives the answer away in its first line', () => {
    // The first hint is a direction, not a solution. If it names the field to
    // change, the brief is a reading exercise.
    for (const c of CHALLENGES) {
      expect(c.hints[0]?.length ?? 0, `${c.id} first hint`).toBeLessThan(140);
    }
  });

  it('no copy uses an em dash', () => {
    for (const c of CHALLENGES) {
      for (const text of [c.name, c.brief, c.lesson, ...c.hints]) {
        expect(text, c.id).not.toContain('—');
      }
    }
  });
});

describe('what a brief holds still', () => {
  it('holds the work still', () => {
    expect(FIXED_DURING_CHALLENGE).toContain('serviceMs');
  });

  it('leaves every design decision editable', () => {
    // The line is between the work and the design, not between easy and hard.
    // Capacity, instances, timeouts and retries are all things an engineer
    // chooses, so none of them is locked.
    for (const field of ['capacity', 'instances', 'timeoutMs', 'retries', 'hitRate']) {
      expect(FIXED_DURING_CHALLENGE, field).not.toContain(field);
    }
  });
});

describe('evaluate', () => {
  const base: Challenge = {
    id: 't',
    version: 1,
    name: 't',
    brief: 't',
    presetId: 'single-server',
    loadRps: 100,
    goals: [{ metric: 'p99', max: 200 }],
    hints: ['t'],
    lesson: 't',
  };

  it('never passes a dead system on latency alone', () => {
    // With no goodput there are no completed requests to take a percentile
    // of, so p99 reads 0 and would satisfy any "under 200ms" goal. A total
    // outage must not score as the best possible latency.
    const dead = {
      system: { p99: 0, p95: 0, errorRate: 1, goodputRps: 0 },
    } as unknown as SimSnapshot;
    const result = evaluate(base, dead);
    expect(result.passed).toBe(false);
    expect(result.goals[0]?.met).toBe(false);
  });

  it('leaves out the goals a snapshot cannot measure', () => {
    // Lost writes and the queue left at the end only mean anything over the
    // check's whole window, so the live view does not pretend to read them.
    const c: Challenge = {
      ...base,
      goals: [
        { metric: 'p99', max: 200 },
        { metric: 'lostWrites', max: 0 },
        { metric: 'queueDepth', max: 100 },
      ],
    };
    const flowing = {
      system: { p99: 50, p95: 40, errorRate: 0, goodputRps: 100 },
    } as unknown as SimSnapshot;
    expect(evaluate(c, flowing).goals.map((g) => g.goal.metric)).toEqual(['p99']);
  });
});
