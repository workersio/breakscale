/**
 * The request tracer.
 *
 * Every other number the simulator reports is an aggregate, and an aggregate
 * says latency ROSE without saying where it went. These assertions pin the
 * one thing the tracer exists to prove: that under load a system's service
 * time stays roughly flat while its QUEUEING grows, which is the reason
 * latency climbs and is not visible in any percentile.
 */

import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS } from './presets';
import type { Topology } from './types';

/** Run a preset at `mult` times its authored load and return the last trace. */
function traceOf(id: string, mult = 1, seed = 7) {
  const t: Topology = structuredClone(PRESETS.find((p) => p.id === id)!.topology);
  for (const n of t.nodes) {
    if (n.kind === 'client') n.config.rps *= mult;
  }
  const e = new Engine(t, seed);
  for (let i = 0; i < 900; i += 1) e.advance(16);
  return { trace: e.snapshot().trace, engine: e };
}

const sum = (
  hops: { queuedMs: number; serviceMs: number }[],
  k: 'queuedMs' | 'serviceMs',
) => hops.reduce((a, h) => a + h[k], 0);

describe('request tracer', () => {
  it('records a completed request through every hop it took', () => {
    const { trace } = traceOf('single-server');
    expect(trace).not.toBeNull();
    expect(trace!.hops.length).toBeGreaterThan(1);
    // The client is deliberately not a hop: its elapsed time IS the total,
    // so booking it would double-count the whole path.
    expect(trace!.hops.every((h) => h.depth > 0)).toBe(true);
  });

  it('orders hops by depth, the way the request walked them', () => {
    const { trace } = traceOf('netflix');
    const depths = trace!.hops.map((h) => h.depth);
    expect([...depths].sort((a, b) => a - b)).toEqual(depths);
  });

  it('shows queueing growing under load while service stays flat', () => {
    // The whole lesson, as an assertion. A student who raises the load and
    // watches only p99 learns that it got worse; this is the part that says
    // WHY, and it must keep being true.
    const low = traceOf('single-server', 1).trace!;
    const high = traceOf('single-server', 6).trace!;

    const qLow = sum(low.hops, 'queuedMs');
    const qHigh = sum(high.hops, 'queuedMs');
    const sLow = sum(low.hops, 'serviceMs');
    const sHigh = sum(high.hops, 'serviceMs');

    expect(qLow).toBeLessThan(1);
    expect(qHigh).toBeGreaterThan(50);
    // Service grows a little (a busier node draws from the same distribution
    // but its slow draws matter more), so this is bounded, not fixed.
    expect(sHigh).toBeLessThan(sLow * 3);
    // And the growth is overwhelmingly queueing, not work.
    expect(qHigh).toBeGreaterThan(sHigh);
  });

  it('charges a node only its OWN work, never its dependency wait', () => {
    // A caller blocked on a slow dependency would otherwise read as slow
    // itself, which would blame the wrong node for the whole path.
    const { trace } = traceOf('single-server', 6);
    expect(trace!.ok).toBe(true);
    const deepest = Math.max(...trace!.hops.map((h) => h.depth));
    const bottom = trace!.hops.filter((h) => h.depth === deepest);
    // single-server is one serial path with no link latency, so every
    // millisecond of the total is some hop's queueing or some hop's own work,
    // and each is booked once. An api that charged its wait on the database
    // as its own service would book the database's time twice, and the parts
    // would add up to more than the whole.
    const accounted = sum(trace!.hops, 'queuedMs') + sum(trace!.hops, 'serviceMs');
    expect(accounted).toBeLessThanOrEqual(trace!.totalMs + 1e-6);
    // And the database really did take time, so the check above has
    // something to catch.
    expect(sum(bottom, 'queuedMs') + sum(bottom, 'serviceMs')).toBeGreaterThan(20);
  });

  it('accounts for a successful request within its measured total', () => {
    const { trace } = traceOf('single-server', 6);
    expect(trace!.ok).toBe(true);
    const accounted = sum(trace!.hops, 'queuedMs') + sum(trace!.hops, 'serviceMs');
    // Not an equality: a fan-out parent waits on its slowest child while
    // sibling branches also book time, so the parts can exceed the whole.
    // What must hold is that a serial path does not INVENT latency.
    expect(accounted).toBeGreaterThan(trace!.totalMs * 0.8);
  });

  it('records a failed request, with the reason and the attempts it made', () => {
    // retry-storm at 4x sheds, after retrying. The repeated hop at the same
    // depth IS the storm, and is the thing the example teaches.
    const { trace } = traceOf('retry-storm', 4, 11);
    expect(trace!.ok).toBe(false);
    expect(trace!.reason).not.toBeNull();
    const deep = trace!.hops.filter((h) => h.depth === 2);
    expect(deep.length).toBeGreaterThan(1);
  });

  it('never reports a negative duration', () => {
    for (const id of ['single-server', 'netflix', 'discord', 'stripe']) {
      for (const m of [1, 4]) {
        const { trace } = traceOf(id, m);
        if (!trace) continue;
        for (const h of trace.hops) {
          expect(h.queuedMs, `${id} ${m}x ${h.nodeId}`).toBeGreaterThanOrEqual(0);
          expect(h.serviceMs, `${id} ${m}x ${h.nodeId}`).toBeGreaterThanOrEqual(0);
        }
        expect(trace.totalMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('names only nodes that exist in the topology', () => {
    const preset = PRESETS.find((p) => p.id === 'netflix')!;
    const ids = new Set(preset.topology.nodes.map((n) => n.id));
    const { trace } = traceOf('netflix');
    for (const h of trace!.hops) expect(ids.has(h.nodeId), h.nodeId).toBe(true);
  });

  it('keeps sampling after a traced request fails', () => {
    // A traced request that dies must free the sampler, or the first failure
    // would be the last trace the run ever produced.
    const { engine } = traceOf('retry-storm', 4, 11);
    const first = engine.snapshot().trace;
    for (let i = 0; i < 400; i += 1) engine.advance(16);
    const later = engine.snapshot().trace;
    expect(later).not.toBeNull();
    expect(later!.startMs).toBeGreaterThan(first!.startMs);
  });

  it('drops the trace on reset, with the run that produced it', () => {
    const { engine } = traceOf('single-server');
    expect(engine.snapshot().trace).not.toBeNull();
    engine.reset();
    expect(engine.snapshot().trace).toBeNull();
  });
});
