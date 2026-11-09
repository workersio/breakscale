import { describe, expect, it } from 'vitest';
import { pumpJob } from './breakitJob';
import type { BreakJobResult } from './breakitJob';
import { DEFAULT_OPTIONS, runSearch } from './sim/breakit';
import { PRESETS } from './sim/presets';

/* Where the search runs never changes what it finds: the worker and the
   main-thread fallback step one generator, in slices of any size. */
describe('break it job', () => {
  it('pumped in slices, gives what a straight run gives', () => {
    const p = PRESETS.find((x) => x.id === 'cache-aside');
    if (!p) throw new Error('cache-aside');
    const goal = { metric: 'errorRate' as const, max: 1 };
    const straight = runSearch(p.topology, goal, DEFAULT_OPTIONS);
    let out: BreakJobResult | null = null;
    const queue: (() => void)[] = [];
    // A zero budget runs one step per slice, the smallest slice there is.
    const ctl = pumpJob(
      {
        kind: 'search',
        design: p.topology,
        goal,
        opts: DEFAULT_OPTIONS,
        remembered: [],
      },
      0,
      () => {},
      (r) => {
        out = r;
      },
      (fn) => queue.push(fn),
    );
    let slices = 0;
    while (queue.length > 0) {
      const fn = queue.shift() as () => void;
      if (slices === 20) {
        ctl.pause();
        ctl.resume();
      }
      fn();
      slices++;
    }
    expect(slices).toBeGreaterThan(20);
    expect(out).toEqual({ kind: 'search', result: straight });
  });
});
