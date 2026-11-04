import { Engine } from '../../src/sim/engine';
import { sanitizeSeed } from '../../src/sim/seed';
import type { FailureReason, SimSnapshot, Topology } from '../../src/sim/types';

/* ------------------------------------------------------------------ *
 * Running a design with nobody watching, and saying what happened.
 *
 * The canvas is for the person; this is for the model. A host that
 * cannot draw the canvas (a terminal agent, say) still gets the answer
 * the canvas would have shown, and a host that can draw it still gives
 * the model something to reason about, since the model cannot see the
 * canvas either way.
 *
 * Every number below comes straight off an engine snapshot. Where a
 * metric means nothing for a kind (a rate limiter has no utilisation to
 * speak of) the line leaves it out rather than printing a zero that
 * reads like a measurement.
 * ------------------------------------------------------------------ */

export interface RunOptions {
  /** Simulated seconds. */
  seconds: number;
  seed: number;
  /**
   * Wall-clock ceiling in ms. A design offering a million requests a
   * second would otherwise hold the server for as long as it takes, and
   * on a hosted server that is somebody else's request waiting.
   */
  budgetMs: number;
}

export const DEFAULT_RUN: RunOptions = { seconds: 30, seed: 1, budgetMs: 3000 };

export interface RunResult {
  snapshot: SimSnapshot;
  /** How far the simulation actually got, which is less than asked when it ran out of budget. */
  simulatedMs: number;
  /** The seed the run used: the design's own when it carries one, else the option's. */
  seed?: number;
}

/*
 * One frame, the same step the app drives the engine at.
 *
 * It cannot be coarser than a rate bucket. The engine's trailing window is
 * ten 100ms buckets and `rate()` excludes the one still filling, so
 * stepping a whole 100ms per call lands every reading on that partial
 * bucket and every rate comes back 0.0/s. That is how a design offered a
 * million a second reported "offered 0.0/s, served 0.0/s, 0.0% failed"
 * beside a component pinned at 100% busy.
 */
const STEP_MS = 1000 / 60;

export function runDesign(
  topology: Topology,
  opts: RunOptions = DEFAULT_RUN,
): RunResult {
  // A design that carries a seed is asking to be replayed, so its seed wins
  // over the default. Its fault schedule needs nothing here: the engine
  // plays it from the topology.
  const seed = sanitizeSeed(topology.seed) ?? opts.seed;
  const engine = new Engine(topology, seed);
  const target = opts.seconds * 1000;
  const start = performance.now();
  let simulatedMs = 0;
  while (simulatedMs < target && performance.now() - start < opts.budgetMs) {
    engine.advance(STEP_MS);
    simulatedMs += STEP_MS;
  }
  return { snapshot: engine.snapshot(), simulatedMs, seed };
}

const REASON_WORDS: Record<FailureReason, string> = {
  error: 'failed on their own (errorRate)',
  shed: 'were turned away by a full queue',
  timeout: 'timed out',
  'no-route': 'had nowhere to go',
  depth: 'looped past the hop limit',
  throttled: 'were refused by a rate limiter',
  rejected: 'were refused by an open circuit breaker',
  crashed: 'hit a crashed component',
  partitioned: 'crossed a cut network link',
  'region-down': 'found no region serving',
  'conn-refused': 'were refused a websocket connection',
  unauthorized: 'failed authentication at the API gateway',
  'bulkhead-full': 'were refused by a full bulkhead',
  'acquire-timeout': 'gave up waiting for a pool slot',
  deprioritized: 'were dropped by a load shedder',
  'packet-loss': 'were lost on a lossy network link (lossRate)',
};

const ms = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
const perSec = (v: number) => `${v >= 100 ? Math.round(v) : v.toFixed(1)}/s`;

/** Plain text for the model: the system first, then the components that explain it. */
export function describeRun(
  topology: Topology,
  run: RunResult,
  opts: RunOptions,
): string {
  const { system, nodes, failuresByReason } = run.snapshot;
  const lines: string[] = [];

  const secs = Math.round(run.simulatedMs / 1000);
  const short =
    run.simulatedMs < opts.seconds * 1000
      ? ` (stopped at ${secs}s of ${opts.seconds}s: the design is too heavy to simulate further here)`
      : '';
  lines.push(`Simulated ${secs}s with seed ${run.seed ?? opts.seed}${short}.`);
  lines.push(
    `Offered ${perSec(system.offeredRps)}, served ${perSec(system.goodputRps)}, ` +
      `${pct(system.errorRate)} failed. ` +
      `Latency p50 ${ms(system.p50)}, p95 ${ms(system.p95)}, p99 ${ms(system.p99)}.`,
  );

  const reasons = (Object.entries(failuresByReason) as [FailureReason, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push(
      'Failed requests over the run: ' +
        reasons.map(([r, n]) => `${n} ${REASON_WORDS[r] ?? r}`).join('; ') +
        '.',
    );
  }

  const byId = new Map(topology.nodes.map((n) => [n.id, n]));
  const rows = Object.entries(nodes)
    .map(([id, s]) => ({ id, s, node: byId.get(id) }))
    .filter((r) => r.node && r.node.kind !== 'client');

  const busy = rows
    .filter((r) => r.s.utilization > 0)
    .sort((a, b) => b.s.utilization - a.s.utilization);
  const failing = rows.filter(
    (r) => r.s.errorRate > 0 || r.s.shedRate > 0 || r.s.timeoutRate > 0,
  );
  const shown = [...new Set([...busy.slice(0, 5), ...failing])];

  if (shown.length > 0) {
    lines.push('', 'Components (busiest first):');
    for (const { id, s, node } of shown) {
      const parts = [`${perSec(s.arrivalRate)} in, ${perSec(s.throughput)} done`];
      if (s.utilization > 0) parts.push(`${pct(Math.min(s.utilization, 1))} busy`);
      if (s.queued >= 1) parts.push(`${Math.round(s.queued)} waiting`);
      if (s.throughput > 0) parts.push(`p99 ${ms(s.p99)}`);
      if (s.errorRate > 0) parts.push(`${pct(s.errorRate)} failed`);
      if (s.shedRate > 0) parts.push(`${perSec(s.shedRate)} turned away`);
      if (s.timeoutRate > 0) parts.push(`${perSec(s.timeoutRate)} timed out`);
      if (node?.kind === 'cache' || node?.kind === 'cdn')
        parts.push(`hit rate ${pct(s.hitRate)}`);
      lines.push(
        `- ${node?.label ?? id} (${node?.kind}, id '${id}'): ${parts.join(', ')}`,
      );
    }
  }

  return lines.join('\n');
}
