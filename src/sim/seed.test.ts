import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS } from './presets';
import { DEFAULT_SEED, MAX_SEED, sanitizeSeed } from './seed';
import type { Topology } from './types';

const single = (): Topology =>
  structuredClone(PRESETS.find((p) => p.id === 'single-server')!.topology);

/** A run's snapshots, one per 100ms of simulated time. */
function run(engine: Engine, frames = 30): string {
  const out: string[] = [];
  for (let i = 0; i < frames; i++) {
    engine.advance(100);
    out.push(JSON.stringify(engine.snapshot()));
  }
  return out.join('\n');
}

describe('sanitizeSeed', () => {
  it('takes exactly the seeds the engine uses as given', () => {
    for (const seed of [0, 1, 42, MAX_SEED]) expect(sanitizeSeed(seed)).toBe(seed);
    for (const bad of [-1, 1.5, MAX_SEED + 1, Number.NaN, Infinity, '7', null, {}]) {
      expect(sanitizeSeed(bad)).toBeUndefined();
    }
  });
});

describe('a topology carrying its seed', () => {
  it('runs on it when the engine is not handed one', () => {
    expect(run(new Engine({ ...single(), seed: 9 }))).toBe(
      run(new Engine(single(), 9)),
    );
    expect(run(new Engine({ ...single(), seed: 9 }))).not.toBe(
      run(new Engine(single())),
    );
  });

  it('runs on the default without one, as before the field existed', () => {
    expect(new Engine(single()).runSeed()).toBe(DEFAULT_SEED);
    expect(run(new Engine(single()))).toBe(run(new Engine(single(), 1)));
  });

  it('gives way to a seed handed to the engine', () => {
    const engine = new Engine({ ...single(), seed: 9 }, 3);
    expect(engine.runSeed()).toBe(3);
    expect(run(engine)).toBe(run(new Engine(single(), 3)));
  });

  it('ignores a seed the engine would fold into another one', () => {
    for (const seed of [-1, 1.5, MAX_SEED + 1]) {
      expect(new Engine({ ...single(), seed }).runSeed()).toBe(DEFAULT_SEED);
    }
  });

  it('is exported only when it is not the default', () => {
    expect('seed' in new Engine(single()).exportTopology()).toBe(false);
    expect('seed' in new Engine(single(), 1).exportTopology()).toBe(false);
    expect(new Engine(single(), 5).exportTopology().seed).toBe(5);
  });

  it('changes the next run, not the one in progress, when set mid-run', () => {
    const engine = new Engine(single());
    const before = run(engine, 10);
    engine.setTopology({ ...single(), seed: 9 });
    expect(engine.runSeed()).toBe(9);
    // Without a seed the topology leaves the current one alone.
    engine.setTopology(single());
    expect(engine.runSeed()).toBe(9);
    engine.reset();
    expect(run(engine, 10)).toBe(run(new Engine(single(), 9), 10));
    expect(run(new Engine(single()), 10)).toBe(before);
  });
});
