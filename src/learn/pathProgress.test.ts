import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import { CHALLENGES } from '../sim/challenges';
import type { Topology } from '../sim/types';
import { LEARNING_PATH } from '../content/learningPath';
import {
  EXPLORE_FACTOR,
  EXPLORE_MS,
  PATH_KEY,
  PathProgress,
  loadExplored,
  nextStep,
  offeredLoad,
  saveExplored,
  stepStatus,
} from './pathProgress';

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p.topology;
}

function scaled(t: Topology, factor: number): Topology {
  return {
    ...t,
    nodes: t.nodes.map((n) =>
      n.kind === 'client'
        ? { ...n, config: { ...n.config, rps: Math.round(n.config.rps * factor) } }
        : n,
    ),
  };
}

/**
 * Feeds the tracker the way the app does: the real engine, seed 1, one
 * snapshot per 100ms of simulated time.
 */
function run(
  progress: PathProgress,
  presetId: string | null,
  topology: Topology,
  seconds: number,
): void {
  const engine = new Engine(topology, 1);
  progress.observe(presetId, topology, engine.snapshot().system.timeMs);
  for (let i = 0; i < seconds * 10; i += 1) {
    engine.advance(100);
    progress.observe(presetId, topology, engine.snapshot().system.timeMs);
  }
}

const noSave = () => {};

describe('exploring an example', () => {
  it('counts once it has run at twice its load for 10 seconds', () => {
    const progress = new PathProgress(new Set(), noSave);
    const listener = vi.fn();
    progress.subscribe(listener);
    run(progress, 'single-server', scaled(preset('single-server'), 2), 9.8);
    expect(progress.getExplored().has('single-server')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    const again = new PathProgress(new Set(), noSave);
    again.subscribe(listener);
    run(again, 'single-server', scaled(preset('single-server'), 2), 10.1);
    expect(again.getExplored().has('single-server')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not count below twice the starting load', () => {
    const progress = new PathProgress(new Set(), noSave);
    run(progress, 'single-server', scaled(preset('single-server'), 1.9), 30);
    expect(progress.getExplored().size).toBe(0);
  });

  it('does not count a challenge or a design of your own', () => {
    const progress = new PathProgress(new Set(), noSave);
    run(progress, null, scaled(preset('single-server'), 4), 30);
    expect(progress.getExplored().size).toBe(0);
  });

  it('starts over when a different example is loaded', () => {
    const progress = new PathProgress(new Set(), noSave);
    run(progress, 'single-server', scaled(preset('single-server'), 2), 8);
    run(progress, 'cache-aside', scaled(preset('cache-aside'), 2), 0.5);
    run(progress, 'single-server', scaled(preset('single-server'), 2), 8);
    expect(progress.getExplored().size).toBe(0);
  });

  it('credits a long gap between snapshots as one second', () => {
    const progress = new PathProgress(new Set(), noSave);
    const t = scaled(preset('single-server'), 2);
    progress.observe('single-server', t, 0);
    progress.observe('single-server', t, 60_000);
    expect(progress.getExplored().size).toBe(0);
  });

  it('saves what it marks', () => {
    const save = vi.fn();
    const progress = new PathProgress(new Set(), save);
    run(progress, 'retry-storm', scaled(preset('retry-storm'), 2), 11);
    expect(save).toHaveBeenCalledTimes(1);
    expect([...save.mock.calls[0]![0]]).toEqual(['retry-storm']);
  });

  it('takes a credit once, and only for a real example', () => {
    const save = vi.fn();
    const progress = new PathProgress(new Set(), save);
    progress.credit('single-server');
    progress.credit('single-server');
    progress.credit('not-an-example');
    expect([...progress.getExplored()]).toEqual(['single-server']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  /* The slider tops out at 5000 a second. An example whose doubled load is
     out of its reach could never be marked done. */
  it('is reachable from the load slider for every example', () => {
    for (const p of PRESETS) {
      expect(offeredLoad(p.topology) * EXPLORE_FACTOR, p.id).toBeLessThanOrEqual(5000);
    }
    expect(EXPLORE_MS).toBe(10_000);
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
    const passedIds = new Set(CHALLENGES.map((c) => c.id));
    expect(nextStep(all, (id) => (passedIds.has(id) ? 'passed' : null))).toBeNull();
  });
});
