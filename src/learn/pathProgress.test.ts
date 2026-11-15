import { describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../sim/presets';
import { CHALLENGES } from '../sim/challenges';
import { INCIDENTS } from '../sim/incidents';
import { LEARNING_PATH } from '../content/learningPath';
import {
  PATH_KEY,
  PathProgress,
  loadExplored,
  nextStep,
  offeredLoad,
  saveExplored,
  stepAfter,
  stepName,
  stepOfBrief,
  stepStatus,
} from './pathProgress';

const noSave = () => {};

describe('marking an example done', () => {
  it('takes a credit once, and only for a real example', () => {
    const save = vi.fn();
    const listener = vi.fn();
    const progress = new PathProgress(new Set(), save);
    progress.subscribe(listener);
    progress.credit('single-server');
    progress.credit('single-server');
    progress.credit('not-an-example');
    expect([...progress.getExplored()]).toEqual(['single-server']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps what an earlier visit marked', () => {
    const progress = new PathProgress(new Set(['cache-aside']), noSave);
    progress.credit('single-server');
    expect([...progress.getExplored()].sort()).toEqual([
      'cache-aside',
      'single-server',
    ]);
  });

  it('reads the offered load the slider sets', () => {
    const p = PRESETS.find((x) => x.id === 'specialised-stores');
    // Two clients, 240 and 6 a second.
    expect(p && offeredLoad(p.topology)).toBe(246);
  });
});

describe('stored progress', () => {
  const store = (raw: string | null) => ({ getItem: () => raw });

  it('round-trips', () => {
    let saved = '';
    saveExplored(new Set(['single-server', 'uber']), {
      setItem: (k, v) => {
        expect(k).toBe(PATH_KEY);
        saved = v;
      },
    });
    expect([...loadExplored(store(saved))]).toEqual(['single-server', 'uber']);
  });

  it('drops ids that are not examples', () => {
    const raw = JSON.stringify({ explored: ['single-server', 'gone', 7, null] });
    expect([...loadExplored(store(raw))]).toEqual(['single-server']);
  });

  it('reads corrupt or blocked storage as nothing explored', () => {
    expect(loadExplored(store('{nope')).size).toBe(0);
    expect(loadExplored(store('null')).size).toBe(0);
    expect(loadExplored(store('[1,2]')).size).toBe(0);
    expect(
      loadExplored({
        getItem: () => {
          throw new Error('blocked');
        },
      }).size,
    ).toBe(0);
    expect(() =>
      saveExplored(new Set(['uber']), {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });
});

describe('where the student stands', () => {
  const none = () => null;

  it('starts at the first step', () => {
    expect(nextStep(new Set(), none)).toBe(LEARNING_PATH[0]!.steps[0]);
  });

  it('takes a passed challenge as done and a started one as not', () => {
    const challenge = LEARNING_PATH[0]!.steps.find((s) => s.kind === 'challenge')!;
    expect(stepStatus(challenge, new Set(), () => 'passed')).toBe('done');
    expect(stepStatus(challenge, new Set(), () => 'in-progress')).toBe('started');
    expect(stepStatus(challenge, new Set(), none)).toBe('todo');
  });

  it('is finished when every step is done', () => {
    const all = new Set(PRESETS.map((p) => p.id));
    expect(nextStep(all, () => 'passed')).toBeNull();
    const passedIds = new Set([
      ...CHALLENGES.map((c) => c.id),
      ...INCIDENTS.map((i) => i.brief.id),
    ]);
    expect(nextStep(all, (id) => (passedIds.has(id) ? 'passed' : null))).toBeNull();
  });
});

describe('real outages on the path', () => {
  const outage = INCIDENTS[0]!;
  const step = LEARNING_PATH.flatMap((t) => t.steps).find((s) => s.id === outage.id)!;

  it('is judged by the brief its Fix it hands over to', () => {
    const badge = (state: 'passed' | 'in-progress') => (id: string) =>
      id === outage.brief.id ? state : null;
    expect(step.kind).toBe('incident');
    expect(stepStatus(step, new Set(), () => null)).toBe('todo');
    expect(stepStatus(step, new Set(), badge('in-progress'))).toBe('started');
    expect(stepStatus(step, new Set(), badge('passed'))).toBe('done');
    expect(stepOfBrief(outage.brief.id)).toBe(step);
    expect(stepName(step)).toBe(outage.name);
  });

  /* The id an outage and its brief share is never taken for an example's
     or a challenge's. */
  it('goes on in path order, from a brief and from an example', () => {
    expect(stepAfter('stripe', 'example')).toBe(step);
    expect(stepAfter(outage.id, 'incident')?.id).toBe(INCIDENTS[1]!.id);
    expect(stepAfter(INCIDENTS[2]!.id, 'incident')).toBeNull();
    expect(stepAfter('hold-the-line', 'challenge')?.id).toBe('nothing-looks-busy');
    expect(stepAfter('nothing-looks-busy', 'challenge')?.id).toBe('cache-aside');
    expect(stepAfter('hold-the-line', 'example')).toBeNull();
  });
});
