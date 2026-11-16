/**
 * How fast the live run plays.
 *
 * The engine steps in simulated time and only ever sees advance(dt). At 1x a
 * frame hands it the frame's wall time. Faster speeds hand it the SAME frame
 * size several times over, never one bigger step: the autoscaler and pool
 * ticks fire at advance boundaries, so a 2x frame of two 16ms advances
 * behaves exactly like two 1x frames of 16ms, where one 32ms advance would
 * not. Slower than 1x is one half-size advance, which is what a 1x run on a
 * machine drawing frames twice as often would do.
 *
 * Checks, replays and share links run headless with fixed steps and never
 * pass through here, so speed changes no verdict and no link.
 */

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Wall time a frame may spend on its extra advances. Past this the frame
 * stops early rather than drop the next one: a design too heavy to run 4x
 * on this machine runs as fast as it can, and the meter below says how fast.
 */
export const FRAME_BUDGET_MS = 8;

/** One step slower or faster, held at the ends. For the [ and ] keys. */
export function stepSpeed(speed: Speed, dir: -1 | 1): Speed {
  const i = SPEEDS.indexOf(speed) + dir;
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))] ?? speed;
}

/** The next speed round the cycle, for the one button in the bar. */
export function cycleSpeed(speed: Speed): Speed {
  return SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;
}

/** "0.5×", "2×", or a measured "2.6×". */
export function formatSpeed(x: number): string {
  const r = Math.round(x * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}×`;
}

/**
 * Advance one frame at `speed`. `frameMs` is the frame's 1x size, already
 * clamped by the caller. Returns the simulated ms actually advanced, which is
 * less than speed x frameMs only when the budget ran out.
 *
 * At 1x this is one advance(frameMs) and reads no clock, so a 1x run does
 * exactly what it did before speed existed.
 */
export function advanceAtSpeed(
  advance: (dt: number) => void,
  frameMs: number,
  speed: Speed,
  now: () => number,
  budgetMs: number = FRAME_BUDGET_MS,
): number {
  if (speed <= 1) {
    const dt = frameMs * speed;
    advance(dt);
    return dt;
  }
  const start = now();
  let done = 0;
  for (let i = 0; i < speed; i += 1) {
    advance(frameMs);
    done += frameMs;
    if (now() - start > budgetMs) break;
  }
  return done;
}

/**
 * The speed this machine is really managing, as simulated time over the time
 * a 1x run would have advanced in the same frames. Counting against 1x rather
 * than the wall clock keeps a backgrounded tab, whose single long frame is
 * clamped, from reading as a slow machine.
 *
 * Reports once per `windowMs` of 1x time and returns null in between.
 */
export class SpeedMeter {
  private sim = 0;
  private base = 0;
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  add(simMs: number, baseMs: number): number | null {
    this.sim += simMs;
    this.base += baseMs;
    if (this.base < this.windowMs) return null;
    const ratio = this.sim / this.base;
    this.sim = 0;
    this.base = 0;
    return ratio;
  }

  clear(): void {
    this.sim = 0;
    this.base = 0;
  }
}

/**
 * The measured speed worth showing instead of the chosen one, or null. Only a
 * clear shortfall counts: a 4x run that lands at 3.8x is 4x for anyone
 * watching, and a number that flickers between the two says nothing.
 */
export function shortfall(chosen: Speed, measured: number | null): number | null {
  if (measured === null || chosen <= 1 || !Number.isFinite(measured)) return null;
  return measured < chosen * 0.9 ? measured : null;
}
