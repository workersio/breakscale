import { cos, log, pow } from './fdlibm';

/** Deterministic PRNG (mulberry32) so a given seed replays identically. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Exponential with the given mean. */
  exponential(mean: number): number {
    if (mean <= 0) return 0;
    // Guard against log(0).
    const u = 1 - this.next();
    return -log(u) * mean;
  }

  /**
   * Service time with a target mean and coefficient of variation.
   * cv=0 -> deterministic, cv=1 -> exponential, cv>1 -> heavy tailed.
   * Implemented as a gamma draw with shape k = 1/cv^2.
   */
  serviceTime(mean: number, cv: number): number {
    if (mean <= 0) return 0;
    if (cv <= 0.01) return mean;
    const shape = 1 / (cv * cv);
    const scale = mean / shape;
    return this.gamma(shape, scale);
  }

  /** Marsaglia-Tsang gamma sampler. */
  gamma(shape: number, scale: number): number {
    if (shape < 1) {
      // Boost low shapes into the valid range.
      const u = 1 - this.next();
      return this.gamma(shape + 1, scale) * pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = 1 - this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (log(u) < 0.5 * x * x + d * (1 - v + log(v))) {
        return d * v * scale;
      }
    }
  }

  /** Standard normal via Box-Muller. */
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * log(u)) * cos(2 * Math.PI * v);
  }
}
