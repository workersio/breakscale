import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { Topology } from './types';

/* ------------------------------------------------------------------ *
 * What a design past the engine's own ceiling reports.
 *
 * The engine stops holding more than MAX_LIVE_REQUESTS at once, which is
 * it protecting itself rather than anything the design did. The question
 * these pin is what the READER is told while that is happening, and the
 * answer used to be a number that was quietly wrong: arrivals past the
 * ceiling returned before they were counted, so the offered rate read
 * about a quarter of what the client was really sending here, and zero
 * outright once a bounded queue wedged the system. Either way it reads
 * as a client that slowed down rather than a system refusing work.
 * ------------------------------------------------------------------ */

function overloaded(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config.rps = 50_000;
  const service = { ...makeNode('service', 240, 0), id: 'service' };
  /*
   * No queue limit, which is what makes this about the ENGINE's ceiling
   * rather than the design's own. A service with its default queue sheds
   * long before 200,000 requests are ever live, so the arrivals past the
   * ceiling are never reached and the bug this file exists for does not
   * occur. Letting the queue grow is the only way to get there.
   */
  service.config.queueLimit = Number.MAX_SAFE_INTEGER;
  return {
    nodes: [client, service],
    edges: [{ id: 'e', from: 'client', to: 'service', weight: 1 }],
  };
}

function run() {
  const engine = new Engine(overloaded(), 7);
  // A frame, not a coarser step: the rate window is ten 100ms buckets and
  // excludes the one still filling, so stepping a whole bucket per call
  // reads zero whatever the load.
  for (let i = 0; i < 5 * 60; i += 1) engine.advance(1000 / 60);
  return engine.snapshot();
}

describe('a design past the live-request ceiling', () => {
  it('reports the rate the client is actually sending', () => {
    /*
     * Not merely "more than zero". Past the ceiling the uncounted
     * arrivals used to drag this down to roughly a quarter of the real
     * offered rate, which reads as a client that quietly slowed down
     * rather than a system refusing work. The number has to be close to
     * what was asked for.
     */
    expect(run().system.offeredRps).toBeGreaterThan(40_000);
  });

  it('reports the loss rather than a quiet zero', () => {
    expect(run().system.errorRate).toBeGreaterThan(0.5);
  });

  it('shows the bottleneck as busy, not idle', () => {
    expect(run().nodes['service']!.utilization).toBeGreaterThan(0.9);
  });

  it('never reports serving more than was offered', () => {
    const { system } = run();
    expect(system.goodputRps).toBeLessThanOrEqual(system.offeredRps);
  });
});

/* ------------------------------------------------------------------ *
 * #130: the issue's own design. A fan-out to ten slow services, each with
 * room for 20,000 waiting, fills the engine's 200,000 in about four
 * simulated seconds. Every request after that is refused by the engine,
 * and each refusal has to land in every total, not only in some of them.
 * ------------------------------------------------------------------ */

function fanOut(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config.rps = 5000;
  client.config.timeoutMs = 0;
  const api = { ...makeNode('service', 240, 0), id: 'api' };
  api.config.capacity = 4096;
  api.config.instances = 512;
  api.config.timeoutMs = 0;
  const nodes = [client, api];
  const edges = [{ id: 'e-api', from: 'client', to: 'api', weight: 1 }];
  for (let i = 0; i < 10; i++) {
    const s = { ...makeNode('service', 480, i * 80), id: `s${i}` };
    s.config.capacity = 1;
    s.config.serviceMs = 500;
    s.config.queueLimit = 20000;
    nodes.push(s);
    edges.push({ id: `e-s${i}`, from: 'api', to: `s${i}`, weight: 1 });
  }
  return { nodes, edges };
}

function sumOf(counts: Partial<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v ?? 0;
  return n;
}

describe('requests the engine refuses at its ceiling (#130)', () => {
  function runFanOut(seconds: number) {
    const engine = new Engine(fanOut(), 1);
    engine.startTally();
    for (let i = 0; i < seconds * 60; i++) engine.advance(1000 / 60);
    return { engine, snap: engine.snapshot() };
  }

  it('adds every refusal to the failure total', () => {
    const { snap } = runFanOut(6);
    const refused = snap.ceilingSheds ?? 0;
    // Past the ceiling, or this is not testing anything.
    expect(refused).toBeGreaterThan(10_000);
    expect(snap.system.totalFailed).toBe(sumOf(snap.failuresByReason));
    expect(snap.system.totalFailed).toBeGreaterThanOrEqual(refused);
    expect(snap.failuresByReason.shed).toBeGreaterThanOrEqual(refused);
  });

  it('agrees with the routes and the tally', () => {
    const { engine, snap } = runFanOut(6);
    const routes = engine.routes();
    let failed = 0;
    let sent = 0;
    for (const r of routes) {
      failed += r.totalFailed;
      sent += r.totalRequests;
    }
    expect(failed).toBe(snap.system.totalFailed);
    expect(sent).toBe(snap.system.totalRequests);
    const tally = engine.readTally()!;
    expect(tally.failed).toBe(snap.system.totalFailed);
    expect(sumOf(tally.failuresByReason)).toBe(tally.failed);
    expect(snap.nodes['client']!.totalFailed).toBe(snap.system.totalFailed);
  });

  it('says nothing about the ceiling while the design stays under it', () => {
    const { snap } = runFanOut(3);
    expect(snap.ceilingSheds).toBeUndefined();
    expect('ceilingSheds' in snap).toBe(false);
  });

  it('starts counting again from zero after a reset', () => {
    const { engine } = runFanOut(6);
    engine.reset();
    for (let i = 0; i < 60; i++) engine.advance(1000 / 60);
    const snap = engine.snapshot();
    expect('ceilingSheds' in snap).toBe(false);
    expect(snap.system.totalFailed).toBe(sumOf(snap.failuresByReason));
  });
});
