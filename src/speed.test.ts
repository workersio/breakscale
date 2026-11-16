import { describe, expect, it } from 'vitest';
import { Engine } from './sim/engine';
import { PRESETS } from './sim/presets';
import {
  SpeedMeter,
  advanceAtSpeed,
  cycleSpeed,
  formatSpeed,
  shortfall,
  stepSpeed,
  type Speed,
} from './speed';

const FRAME = 1000 / 60;
const FRAMES = 240;
const still = () => 0;

/** Every snapshot along a run, so a divergence anywhere fails, not only at the end. */
function run(engine: Engine, frames: number, step: () => void): string[] {
  const out: string[] = [];
  for (let i = 0; i < frames; i += 1) {
    step();
    if (i % 6 === 5) out.push(JSON.stringify(engine.snapshot()));
  }
  return out;
}

describe('advanceAtSpeed', () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))(
    '%s: N frames at 2x match 2N frames at 1x of the same size',
    (_, preset) => {
      const fast = new Engine(structuredClone(preset.topology), 7);
      const slow = new Engine(structuredClone(preset.topology), 7);
      const a: string[] = [];
      for (let i = 0; i < FRAMES; i += 1) {
        advanceAtSpeed((dt) => fast.advance(dt), FRAME, 2, still);
        if (i % 3 === 2) a.push(JSON.stringify(fast.snapshot()));
      }
      const b = run(slow, FRAMES * 2, () =>
        advanceAtSpeed((dt) => slow.advance(dt), FRAME, 1, still),
      );
      expect(a).toEqual(b);
    },
  );

  it('4x is four advances of the frame size, 0.5x one of half', () => {
    const calls: number[] = [];
    expect(advanceAtSpeed((dt) => calls.push(dt), 16, 4, still)).toBe(64);
    expect(advanceAtSpeed((dt) => calls.push(dt), 16, 0.5, still)).toBe(8);
    expect(calls).toEqual([16, 16, 16, 16, 8]);
  });

  it('1x makes one call of the frame size and reads no clock', () => {
    const calls: number[] = [];
    let reads = 0;
    advanceAtSpeed(
      (dt) => calls.push(dt),
      16.7,
      1,
      () => {
        reads += 1;
        return 0;
      },
    );
    expect(calls).toEqual([16.7]);
    expect(reads).toBe(0);
  });

  it('stops early once the frame budget is spent, never before the first advance', () => {
    let t = 0;
    const calls: number[] = [];
    const done = advanceAtSpeed(
      (dt) => {
        calls.push(dt);
        t += 5;
      },
      16,
      4,
      () => t,
      8,
    );
    expect(calls.length).toBe(2);
    expect(done).toBe(32);
  });
});

describe('speed steps', () => {
  it('steps and holds at the ends', () => {
    expect(stepSpeed(1, 1)).toBe(2);
    expect(stepSpeed(4, 1)).toBe(4);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    expect(stepSpeed(1, -1)).toBe(0.5);
  });

  it('cycles round', () => {
    const seen: Speed[] = [];
    let s: Speed = 1;
    for (let i = 0; i < 4; i += 1) seen.push((s = cycleSpeed(s)));
    expect(seen).toEqual([2, 4, 0.5, 1]);
  });

  it('formats', () => {
    expect(formatSpeed(0.5)).toBe('0.5×');
    expect(formatSpeed(2)).toBe('2×');
    expect(formatSpeed(2.63)).toBe('2.6×');
    expect(formatSpeed(3.98)).toBe('4×');
  });
});

describe('SpeedMeter', () => {
  it('reports sim time over 1x time once a window has passed', () => {
    const m = new SpeedMeter(1000);
    let r: number | null = null;
    for (let i = 0; i < 120 && r === null; i += 1) r = m.add(FRAME * 2.5, FRAME);
    expect(r).toBeCloseTo(2.5, 6);
  });

  it('shows only a clear shortfall', () => {
    expect(shortfall(4, 3.8)).toBeNull();
    expect(shortfall(4, 2.6)).toBe(2.6);
    expect(shortfall(1, 0.4)).toBeNull();
    expect(shortfall(2, null)).toBeNull();
  });
});
