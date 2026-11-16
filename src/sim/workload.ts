import { log } from './fdlibm';
import { DEFAULT_TRAFFIC_PERIOD_S, type NodeConfig } from './types';

/*
 * The two arrival shapes that are not rate curves: bursty clumps and a
 * thundering herd. Both read client config and nothing else, so the engine
 * and the inspector agree on what a missing or out-of-range field means.
 */

/** Average requests per clump when a bursty client does not say. */
export const DEFAULT_BURST_SIZE = 10;
/** Largest average clump a client accepts. */
export const MAX_BURST_SIZE = 50;
/**
 * Most requests one clump can carry, whatever the draw. A clump's size has a
 * long tail, and this keeps one unlucky draw from firing thousands at once.
 */
const MAX_BATCH_FACTOR = 20;

/** Callers in one herd when a client does not say. */
export const DEFAULT_HERD_SIZE = 500;
/** Largest herd a client accepts. */
export const MAX_HERD_SIZE = 5000;
/** Widest window a herd can be spread over, in ms. */
export const MAX_HERD_SPREAD_MS = 10_000;

function clamp(
  v: number | undefined,
  lo: number,
  hi: number,
  fallback: number,
): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Average clump size a bursty client runs with, 1..MAX_BURST_SIZE. */
export function effectiveBurstSize(config: NodeConfig): number {
  return clamp(config.burstSize, 1, MAX_BURST_SIZE, DEFAULT_BURST_SIZE);
}

/** Whole callers in each herd, 0..MAX_HERD_SIZE. */
export function effectiveHerdSize(config: NodeConfig): number {
  return Math.floor(clamp(config.herdSize, 0, MAX_HERD_SIZE, DEFAULT_HERD_SIZE));
}

/** Window a herd is spread over in ms, 0..MAX_HERD_SPREAD_MS. 0 is all at once. */
export function effectiveHerdSpreadMs(config: NodeConfig): number {
  return clamp(config.herdSpreadMs, 0, MAX_HERD_SPREAD_MS, 0);
}

/** One cycle of the client's pattern in ms, or 0 when the period is unusable. */
export function trafficPeriodMs(config: NodeConfig): number {
  const s = config.trafficPeriodS ?? DEFAULT_TRAFFIC_PERIOD_S;
  return s > 0 && Number.isFinite(s) ? s * 1000 : 0;
}

/**
 * How many requests one clump fires, from one uniform draw `u` in [0, 1).
 *
 * Geometric with mean `mean`: the count of tries until one succeeds at a
 * chance of 1 / mean each. Most clumps are small and a few are large, which
 * is what correlated callers look like. Arrivals of clumps are themselves
 * random, so the whole stream is a compound Poisson process with the same
 * average rate as plain random arrivals. Uses the fdlibm log so the count is
 * the same in every browser.
 */
export function burstBatch(u: number, mean: number): number {
  if (!(mean > 1)) return 1;
  const tail = 1 - u;
  const n = 1 + Math.floor(log(tail) / log(1 - 1 / mean));
  const cap = Math.ceil(mean * MAX_BATCH_FACTOR);
  return n > cap ? cap : n;
}

/**
 * The next herd moment strictly after `nowMs`: the next whole multiple of the
 * cycle. A herd is tied to the clock, the way a cache expiry or a cron-driven
 * reconnect is, so it lands at 60s, 120s, ... whatever happened in between.
 */
export function nextHerdMs(nowMs: number, periodMs: number): number {
  return (Math.floor(nowMs / periodMs) + 1) * periodMs;
}
