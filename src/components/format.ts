/**
 * Shared number formatting for every metric rendered in the app.
 * All output is intended to be displayed in `var(--mono)` with tabular-nums.
 *
 * This module is the SOLE owner of number formatting. No component may define
 * its own fmt* helper — five near-duplicate formatters (two of them different
 * functions sharing a name) are what let the same latency read `113` on the
 * canvas and `113ms` in the inspector.
 *
 * Seven rules, in force everywhere:
 *
 *   1. A non-zero value NEVER renders as `0`. Below the smallest representable
 *      step the output degrades to `<1%`, `<1`, `<0.1%` — never a bare zero.
 *      This is the "0% util at 18% load" bug, fixed at the source.
 *   2. A non-100% value never renders as `100%`. 0.996 -> `99.6%`.
 *   3. Percentages: integer at >=10%, one decimal below.
 *   4. Latency >=1000ms switches to seconds.
 *   5. Every formatter emits its own unit. No bare number relying on a
 *      neighbouring tspan for meaning.
 *   6. One sentinel for non-finite input: `n/a`, everywhere.
 *   7. `formatRate` is never applied to a count, and vice versa.
 *
 * Every formatter accepts `number | null | undefined` and returns the sentinel
 * rather than `NaN`, `Infinity`, `null` or `undefined`. Snapshot fields arrive
 * from a live engine and a missing node is a real state, so the guard belongs
 * here rather than at each of the ~40 call sites.
 */

/**
 * The single non-finite sentinel. Never `--` and never `0`. Plain "n/a"
 * rather than a dash character: the readouts must not contain an em dash
 * anywhere, and a lone hyphen reads as a negative sign next to numbers.
 */
export const NA = 'n/a';

/** Alias kept so either name resolves; both refer to the same sentinel. */
export const EMPTY = NA;

/**
 * Narrow an untrusted numeric to a finite number.
 * Returns null for null, undefined, NaN, +/-Infinity and non-numbers — every
 * input shape that would otherwise print garbage into a readout.
 */
function finite(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Strip a trailing `.0` so `4.0` reads `4` without flattening `4.2`. */
function trim(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Group with separators above 9999: `1234` stays, `12345` -> `12,345`. */
function group(n: number): string {
  return n >= 10_000 ? n.toLocaleString('en-US') : `${n}`;
}

/* ------------------------------------------------------------------ *
 * Health thresholds — defined once, imported everywhere, so a chart
 * line and the headline number above it can never disagree about what
 * colour the same value is.
 * ------------------------------------------------------------------ */

export type Health = 'ok' | 'warn' | 'danger';

/** Utilization / saturation in 0..1. */
export const healthOfLoad = (u: number | null | undefined): Health => {
  const v = finite(u);
  return v === null ? 'ok' : v >= 0.9 ? 'danger' : v >= 0.7 ? 'warn' : 'ok';
};

/** Error fraction in 0..1. Half a percent is already worth noticing. */
export const healthOfErr = (e: number | null | undefined): Health => {
  const v = finite(e);
  return v === null ? 'ok' : v >= 0.05 ? 'danger' : v >= 0.005 ? 'warn' : 'ok';
};

/** End-to-end latency in ms. */
export const healthOfLatency = (ms: number | null | undefined): Health => {
  const v = finite(ms);
  return v === null ? 'ok' : v >= 1000 ? 'danger' : v >= 200 ? 'warn' : 'ok';
};

/**
 * Status class for a value, or undefined at `ok`.
 *
 * At `ok` NOTHING is coloured. A healthy screen is entirely neutral, which is
 * precisely what gives --warn and --danger their meaning when they appear.
 */
export const toneClass = (h: Health): string | undefined =>
  h === 'ok' ? undefined : `is-${h}`;

/* ------------------------------------------------------------------ *
 * Formatters
 * ------------------------------------------------------------------ */

/**
 * Latency in milliseconds.
 *
 * Below 10ms one decimal keeps sub-millisecond differences visible; from 10ms
 * up the decimal is stochastic noise on a percentile, so it is dropped. At or
 * above 1000ms the reading switches to seconds rather than printing four
 * significant figures of a number that moves every window.
 *
 * A latency that is genuinely non-zero but rounds below the display step is
 * shown as `<0.1ms`, never `0`.
 */
export function formatMs(ms: number | null | undefined): string {
  const v = finite(ms);
  if (v === null) return NA;
  // A negative latency is not a small latency, it is a broken measurement.
  if (v < 0) return NA;
  if (v === 0) return '0ms';
  if (v < 0.1) return '<0.1ms';
  if (v < 10) return `${trim(v.toFixed(1))}ms`;
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${trim((v / 1000).toFixed(1))}s`;
  return `${group(Math.round(v / 1000))}s`;
}

/**
 * A rate in requests per second. Anything at or above 1000 compacts to `k`
 * so the string cannot outgrow its slot.
 *
 * A trickle below 0.1/s reads `<0.1/s` rather than collapsing to zero — a
 * system shedding one request every twenty seconds is not a healthy one.
 */
export function formatRate(rps: number | null | undefined): string {
  const bare = formatRateBare(rps);
  return bare === NA ? NA : `${bare}/s`;
}

/**
 * The same rate without the `/s` suffix, for slots that state the unit
 * separately — a node's `RPS` caption, an axis whose unit is in its eyebrow.
 * This is the one place rule 5 is satisfied by an adjacent caption rather than
 * by the string itself, and it is why the bare form is a distinct function
 * rather than a flag: a caller must choose it deliberately.
 */
export function formatRateBare(rps: number | null | undefined): string {
  const v = finite(rps);
  if (v === null) return NA;
  if (v < 0) return NA;
  if (v === 0) return '0';
  if (v < 0.1) return '<0.1';
  if (v < 10) return trim(v.toFixed(1));
  if (v < 1000) return `${Math.round(v)}`;
  if (v < 10_000) return `${trim((v / 1000).toFixed(1))}k`;
  return `${Math.round(v / 1000)}k`;
}

/**
 * A count of things — in-flight requests, queued requests, node totals.
 * Counts are never run through `formatRate`: 0.6 in-flight is not "1/s".
 *
 * A fractional backlog below 1 is a real backlog, so it reads `<1`.
 */
export function formatCount(n: number | null | undefined): string {
  const v = finite(n);
  if (v === null) return NA;
  if (v < 0) return NA;
  if (v === 0) return '0';
  // A backlog of 0.4 requests is a real backlog. It must not read `0`.
  if (v < 1) return '<1';
  // Exact up to 6 digits with separators — a request total is a fact, and
  // compacting `128,400` to `128k` throws away precision the student can see
  // changing. Only past a million does the exact digit stop being readable.
  if (v < 1_000_000) return group(Math.round(v));
  return `${trim((v / 1_000_000).toFixed(1))}M`;
}

/**
 * A 0..1 fraction as a percentage.
 *
 * This is the function that carried the headline bug: `Math.round(0.18 * 100)`
 * is fine, but `Math.round(0.004 * 100)` is `0`, and a node at 0.4% load
 * claiming to be idle is a lie the whole simulator rests on. Rules 1-3 apply:
 * integer at >=10%, one decimal below, `<0.1%` for a non-zero value smaller
 * than the display step, and `99.9%` rather than `100%` for anything short of
 * true saturation.
 */
export function formatPct(fraction: number | null | undefined): string {
  const v = finite(fraction);
  if (v === null) return NA;
  if (v < 0) return NA;
  if (v === 0) return '0%';

  const pct = v * 100;

  // Rule 1: a non-zero value never reads `0%` or `0.0%`.
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return `${trim(pct.toFixed(1))}%`;

  if (pct < 100) {
    // Rule 2: never let a value short of the whole round up to a perfect
    // 100%. Report the measured figure at one decimal (0.9996 -> `99.96%`
    // truncated to `99.9%` would invent a reading; one decimal of the real
    // value is both honest and short). We floor rather than round so the
    // displayed number can never exceed the true one.
    const r = Math.round(pct);
    if (r >= 100) return `${(Math.floor(pct * 10) / 10).toFixed(1)}%`;
    return `${r}%`;
  }

  // >=100% is legitimate and meaningful: utilization can be oversubscribed,
  // and clamping it to `100%` would hide exactly the overload being taught.
  return `${Math.round(pct)}%`;
}

/**
 * A bare compacted number with no unit, for axis ticks where the unit is
 * already stated in the axis caption. This is the one formatter permitted to
 * omit its unit, because its unit is printed once for the whole column.
 */
export function formatCompact(n: number | null | undefined): string {
  const v = finite(n);
  if (v === null) return NA;
  const a = Math.abs(v);
  // A compact tick may legitimately be negative (a delta axis), so the sign is
  // carried rather than rejected.
  const sign = v < 0 ? '-' : '';
  if (a === 0) return '0';
  // Rule 1 holds here too: a tick that is not zero must not print `0`.
  // `0.04` rounds to `0.0` at one decimal, so it degrades to a bound instead.
  if (a < 0.05) return `${sign}<0.1`;
  if (a < 1) return `${sign}${trim(a.toFixed(1))}`;
  if (a < 1000) return `${sign}${Math.round(a)}`;
  if (a < 10_000) return `${sign}${trim((a / 1000).toFixed(1))}k`;
  if (a < 1_000_000) return `${sign}${Math.round(a / 1000)}k`;
  return `${sign}${trim((a / 1_000_000).toFixed(1))}M`;
}

/**
 * Elapsed simulation time, as a human would say it.
 *
 * Under a minute reads as seconds with one decimal, because at that scale the
 * tenths are the interesting part — a student stepping frame by frame wants
 * to see the clock move. Past a minute the tenths are noise and the shape
 * "2m 05s" is what a person would actually say out loud.
 */
export function formatElapsed(seconds: number | null | undefined): string {
  const v = finite(seconds);
  if (v === null || v < 0) return NA;
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  const rest = Math.floor(v - m * 60);
  return `${m}m ${String(rest).padStart(2, '0')}s`;
}

/* ------------------------------------------------------------------ *
 * Against a goal.
 *
 * A challenge goal reads "no more than", and a reading set beside one is
 * rounded in the direction that fails it. Rounded to nearest, a p99 of
 * 200.4ms printed "200ms" under "needs 200ms or less" on a run that had
 * missed: the reader saw a pass that the check had not given. Rounded up, a
 * miss always prints past the line, and a value exactly on it still reads as
 * on it.
 * ------------------------------------------------------------------ */

/** Round up to `step`, ignoring the float noise that would push 1.0 to 1.1. */
function ceilTo(v: number, step: number): number {
  return Math.ceil(v / step - 1e-9) * step;
}

/** A latency held against a goal, rounded up. */
export function formatGoalMs(ms: number | null | undefined): string {
  const v = finite(ms);
  if (v === null || v < 0) return NA;
  if (v === 0) return '0ms';
  if (v < 10) return `${trim(ceilTo(v, 0.1).toFixed(1))}ms`;
  if (v < 1000) return `${ceilTo(v, 1).toFixed(0)}ms`;
  return `${trim(ceilTo(v / 1000, 0.1).toFixed(1))}s`;
}

/**
 * A percentage held against a goal, already in percent, rounded up: two
 * decimals under 1%, where the goals sit, one under 10%, whole above.
 */
export function formatGoalPct(pct: number | null | undefined): string {
  const v = finite(pct);
  if (v === null || v < 0) return NA;
  if (v === 0) return '0%';
  if (v < 1) return `${ceilTo(v, 0.01).toFixed(2).replace(/0$/, '')}%`;
  if (v < 10) return `${trim(ceilTo(v, 0.1).toFixed(1))}%`;
  return `${ceilTo(v, 1).toFixed(0)}%`;
}

/**
 * A 0..1 share that has to stay ABOVE a floor, as a percentage rounded down,
 * so a share short of the floor never prints as reaching it.
 */
export function formatShareDown(fraction: number | null | undefined): string {
  const v = finite(fraction);
  if (v === null || v < 0) return NA;
  const pct = Math.floor(v * 1000 + 1e-9) / 10;
  return `${trim(pct.toFixed(1))}%`;
}
