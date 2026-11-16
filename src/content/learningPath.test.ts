import { describe, expect, it } from 'vitest';
import { PRESETS } from '../sim/presets';
import { CHALLENGES } from '../sim/challenges';
import { INCIDENTS } from '../sim/incidents';
import { LEARNING_PATH } from './learningPath';

const steps = LEARNING_PATH.flatMap((t) => t.steps);

describe('the learning path', () => {
  it('has every example exactly once', () => {
    const ids = steps.filter((s) => s.kind === 'example').map((s) => s.id);
    expect([...ids].sort()).toEqual(PRESETS.map((p) => p.id).sort());
  });

  it('has every challenge exactly once', () => {
    const ids = steps.filter((s) => s.kind === 'challenge').map((s) => s.id);
    expect([...ids].sort()).toEqual(CHALLENGES.map((c) => c.id).sort());
  });

  it('has every incident exactly once', () => {
    const ids = steps.filter((s) => s.kind === 'incident').map((s) => s.id);
    expect([...ids].sort()).toEqual(INCIDENTS.map((i) => i.id).sort());
  });

  /* A real outage is met by someone who has already fixed its kind of
     problem in a challenge, so each incident comes after one in its track. */
  it('puts every incident after a challenge in the same track', () => {
    for (const track of LEARNING_PATH) {
      track.steps.forEach((s, i) => {
        if (s.kind !== 'incident') return;
        const before = track.steps.slice(0, i).some((p) => p.kind === 'challenge');
        expect(before, `${s.id} in ${track.id}`).toBe(true);
      });
    }
  });

  /* A brief is set in an example's system. Meeting the system first is the
     point of the order. */
  it('puts every challenge after the example it is set in', () => {
    const at = new Map(steps.map((s, i) => [`${s.kind}:${s.id}`, i]));
    for (const c of CHALLENGES) {
      const brief = at.get(`challenge:${c.id}`);
      const example = at.get(`example:${c.presetId}`);
      expect(brief, c.id).toBeDefined();
      expect(example, c.presetId).toBeDefined();
      expect(brief!, `${c.id} before ${c.presetId}`).toBeGreaterThan(example!);
    }
  });

  it('says what each step teaches in one short sentence', () => {
    for (const s of steps) {
      expect(s.learn, s.id).toMatch(/^[A-Z].*\.$/);
      expect(s.learn.split('. ').length, s.id).toBe(1);
      expect(s.learn.length, s.id).toBeLessThanOrEqual(72);
      expect(s.learn, s.id).not.toContain('—');
    }
    for (const t of LEARNING_PATH) {
      expect(t.about, t.id).not.toContain('—');
      expect(t.steps.length, t.id).toBeGreaterThan(0);
    }
  });

  it('gives each track a unique id', () => {
    const ids = LEARNING_PATH.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
