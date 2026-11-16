import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import {
  EDGE_OUTCOME_SLOTS,
  EO_CUT,
  EO_FAILED,
  EO_FIRST,
  EO_LOST,
  EO_OK,
  EO_REFUSED,
  EO_RETRY,
} from './edgeOutcomes';
import { PRESETS, defaultConfig } from './presets';
import type { NodeConfig, SimEdge, Topology } from './types';

/**
 * The per-edge outcome tally behind the canvas's traffic dots.
 *
 * Two promises. Turning it on changes nothing the snapshot says, for every
 * preset, so replays and share links stay byte-identical. And what it counts
 * is what happened: attempts split into first tries and retries, outcomes
 * split into the ways a call can end.
 */

const STEP = 1000 / 60;

function pair(
  api: Partial<NodeConfig>,
  client: Partial<NodeConfig> = {},
  edge: Partial<SimEdge> = {},
): Topology {
  return {
    nodes: [
      {
        id: 'client',
        kind: 'client',
        label: 'Client',
        x: 0,
        y: 0,
        config: { ...defaultConfig('client'), rps: 1000, ...client },
      },
      {
        id: 'api',
        kind: 'service',
        label: 'API',
        x: 200,
        y: 0,
        config: {
          ...defaultConfig('service'),
          capacity: 1000,
          serviceMs: 2,
          serviceCv: 0,
          queueLimit: 10_000,
          errorRate: 0,
          ...api,
        },
      },
    ],
    edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1, ...edge }],
  };
}

function runFor(engine: Engine, seconds: number): void {
  for (let i = 0; i < 60 * seconds; i++) engine.advance(STEP);
}

function read(engine: Engine, id = 'client->api'): Float64Array {
  const out = new Float64Array(EDGE_OUTCOME_SLOTS);
  expect(engine.readEdgeOutcomes(id, out)).toBe(true);
  return out;
}

const sent = (r: Float64Array) => r[EO_FIRST] + r[EO_RETRY];
const ended = (r: Float64Array) =>
  r[EO_OK] + r[EO_FAILED] + r[EO_REFUSED] + r[EO_LOST] + r[EO_CUT];

describe('edge outcomes: snapshot unchanged', () => {
  it('every preset snapshots the same with counting on as with it off', () => {
    for (const p of PRESETS) {
      const off = new Engine(structuredClone(p.topology), 7);
      const on = new Engine(structuredClone(p.topology), 7);
      on.setEdgeOutcomes(true);
      for (let i = 1; i <= 300; i++) {
        off.advance(STEP);
        on.advance(STEP);
        if (i % 30 === 0) {
          expect(JSON.stringify(on.snapshot()), p.id).toBe(
            JSON.stringify(off.snapshot()),
          );
        }
      }
      // reset() replays from zero; the counters must not survive it either.
      on.reset();
      off.reset();
      runFor(on, 1);
      runFor(off, 1);
      expect(JSON.stringify(on.snapshot()), p.id).toBe(JSON.stringify(off.snapshot()));
    }
  });

  it('reads false while off, and for an edge that does not exist', () => {
    const engine = new Engine(pair({}), 1);
    const out = new Float64Array(EDGE_OUTCOME_SLOTS);
    expect(engine.readEdgeOutcomes('client->api', out)).toBe(false);
    engine.setEdgeOutcomes(true);
    expect(engine.readEdgeOutcomes('nope', out)).toBe(false);
    engine.setEdgeOutcomes(false);
    expect(engine.readEdgeOutcomes('client->api', out)).toBe(false);
  });
});

describe('edge outcomes: what is counted', () => {
  it('a healthy link: every call is a first try and gets through', () => {
    const engine = new Engine(pair({}), 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 5);
    const r = read(engine);
    console.log('healthy', Array.from(r, (v) => Math.round(v)).join(' '));
    expect(r[EO_FIRST]).toBeGreaterThan(900);
    expect(r[EO_RETRY]).toBe(0);
    expect(r[EO_FAILED] + r[EO_REFUSED] + r[EO_LOST] + r[EO_CUT]).toBe(0);
    // The wire's own label counts the same crossings.
    const flow = engine.snapshot().edgeFlow['client->api'];
    expect(r[EO_FIRST]).toBe(flow);
    expect(Math.abs(r[EO_OK] - r[EO_FIRST]) / r[EO_FIRST]).toBeLessThan(0.02);
  });

  it('a lossy link: about the configured share is lost, the rest gets through', () => {
    const engine = new Engine(pair({}, {}, { lossRate: 0.1 }), 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 5);
    const r = read(engine);
    console.log('lossy 10%', Array.from(r, (v) => Math.round(v)).join(' '));
    const lostShare = r[EO_LOST] / ended(r);
    expect(Math.abs(lostShare - 0.1)).toBeLessThan(0.04);
    expect(r[EO_OK] + r[EO_LOST]).toBeCloseTo(ended(r), 6);
    // A lost call never crossed, so the wire's crossing count leaves it out.
    const flow = engine.snapshot().edgeFlow['client->api'];
    expect(flow).toBeLessThan(sent(r));
  });

  it('a cut link: every attempt is counted, none crosses, all end at the cut', () => {
    const engine = new Engine(pair({}, { retries: 1 }), 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 2);
    expect(engine.cutEdge('client->api')).toBe(true);
    runFor(engine, 3);
    const r = read(engine);
    console.log('cut', Array.from(r, (v) => Math.round(v)).join(' '));
    expect(r[EO_FIRST]).toBeGreaterThan(900);
    // One retry per call, each also stopped at the cut.
    expect(Math.abs(r[EO_RETRY] - r[EO_FIRST]) / r[EO_FIRST]).toBeLessThan(0.05);
    expect(r[EO_CUT]).toBeCloseTo(ended(r), 6);
    expect(engine.snapshot().edgeFlow['client->api']).toBe(0);
  });

  it('a failing target with retries: retries are counted apart from first tries', () => {
    const engine = new Engine(pair({ errorRate: 0.5 }, { retries: 2 }), 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 5);
    const r = read(engine);
    console.log('errors 50% retries 2', Array.from(r, (v) => Math.round(v)).join(' '));
    // Expected retries per first try: 0.5 + 0.25 = 0.75.
    expect(Math.abs(r[EO_RETRY] / r[EO_FIRST] - 0.75)).toBeLessThan(0.08);
    expect(Math.abs(r[EO_FAILED] / ended(r) - 0.5)).toBeLessThan(0.05);
    expect(r[EO_REFUSED]).toBe(0);
    // In steady state, attempts and outcomes balance.
    expect(Math.abs(sent(r) - ended(r)) / sent(r)).toBeLessThan(0.05);
  });

  it('a full line: calls are turned away, not failed', () => {
    // Ceiling 1 * 1000 / 10 = 100 rps against 500 offered, 5 places in line.
    const engine = new Engine(
      pair({ capacity: 1, serviceMs: 10, queueLimit: 5 }, { rps: 500 }),
      3,
    );
    engine.setEdgeOutcomes(true);
    runFor(engine, 5);
    const r = read(engine);
    console.log('full line', Array.from(r, (v) => Math.round(v)).join(' '));
    expect(r[EO_REFUSED] / ended(r)).toBeGreaterThan(0.7);
    expect(r[EO_OK]).toBeGreaterThan(80);
    expect(r[EO_OK]).toBeLessThan(110);
  });

  it("books a middle node's answer on the wire it came in on, not the one it retried", () => {
    // The API retries the database; that rewrites the API request's retry
    // target, which once moved the client's outcomes onto the wrong wire.
    const t = pair({ retries: 2 });
    t.nodes.push({
      id: 'db',
      kind: 'service',
      label: 'DB',
      x: 400,
      y: 0,
      config: {
        ...defaultConfig('service'),
        capacity: 1000,
        serviceMs: 2,
        serviceCv: 0,
        queueLimit: 10_000,
        errorRate: 0.5,
      },
    });
    t.edges.push({ id: 'api->db', from: 'api', to: 'db', weight: 1 });
    const engine = new Engine(t, 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 5);
    const front = read(engine);
    const back = read(engine, 'api->db');
    console.log('chain front', Array.from(front, (v) => Math.round(v)).join(' '));
    console.log('chain back', Array.from(back, (v) => Math.round(v)).join(' '));
    for (const r of [front, back]) {
      expect(Math.abs(sent(r) - ended(r)) / sent(r)).toBeLessThan(0.05);
    }
    // Three tries at a coin flip: one call in eight fails all of them.
    expect(Math.abs(front[EO_FAILED] / ended(front) - 0.125)).toBeLessThan(0.04);
    expect(back[EO_RETRY]).toBeGreaterThan(0);
  });

  it('a refusal further down is a failure on the wires above it', () => {
    // The database turns most calls away; the API lets every call in.
    const t = pair({}, { rps: 500 });
    t.nodes.push({
      id: 'db',
      kind: 'service',
      label: 'DB',
      x: 400,
      y: 0,
      config: {
        ...defaultConfig('service'),
        capacity: 1,
        serviceMs: 10,
        serviceCv: 0,
        queueLimit: 5,
        errorRate: 0,
      },
    });
    t.edges.push({ id: 'api->db', from: 'api', to: 'db', weight: 1 });
    const engine = new Engine(t, 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 5);
    const front = read(engine);
    const back = read(engine, 'api->db');
    expect(back[EO_REFUSED] / ended(back)).toBeGreaterThan(0.7);
    expect(front[EO_REFUSED]).toBe(0);
    expect(front[EO_FAILED] / ended(front)).toBeGreaterThan(0.7);
  });

  it('survives a topology edit, keeping counters for edges that stay', () => {
    const t = pair({});
    const engine = new Engine(t, 3);
    engine.setEdgeOutcomes(true);
    runFor(engine, 2);
    engine.setTopology({ ...t, nodes: t.nodes.map((n) => ({ ...n, x: n.x + 8 })) });
    expect(read(engine)[EO_FIRST]).toBeGreaterThan(900);
  });
});
