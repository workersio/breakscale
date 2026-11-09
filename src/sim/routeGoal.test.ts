import { describe, expect, it } from 'vitest';
import { evaluate, isRouteGoal } from './challenge';
import type { Challenge, Goal } from './challenge';
import { CHALLENGES } from './challenges';
import { Engine } from './engine';
import { measureWindow, playRun } from './judge';
import { PRESETS, defaultConfig } from './presets';
import type { Topology } from './types';

/*
 * A goal on one route: "checkout stays up" while something only the other
 * users touch is broken. Stripe has two kinds of user. Merchants pay
 * through the payment service; dashboard readers go through the reporting
 * API, which nothing else calls, so slowing it hurts only them.
 */

function stripe(): Topology {
  const t = PRESETS.find((p) => p.id === 'stripe')?.topology;
  if (!t) throw new Error('no stripe preset');
  return {
    ...structuredClone(t),
    faults: [
      {
        atMs: 0,
        action: 'inject',
        nodeId: 'reportsvc',
        kind: 'slow',
        opts: { factor: 40 },
      },
    ],
  };
}

function challenge(goals: Goal[]): Challenge {
  return {
    id: 'route-goal-test',
    version: 1,
    name: 'Keep payments up',
    brief: 'Reporting is slow. Payments must stay up.',
    presetId: 'stripe',
    loadRps: 220,
    goals,
    warmupS: 5,
    windowS: 10,
    hints: [],
    lesson: '',
  };
}

function run(goals: Goal[]) {
  const play = playRun(challenge(goals), stripe(), 1);
  for (;;) {
    const step = play.next();
    if (step.done) return step.value;
  }
}

describe('a goal on one route', () => {
  it('judges only that client’s requests', () => {
    const r = run([
      { metric: 'errorRate', max: 6, route: 'merchants' },
      { metric: 'errorRate', max: 1, route: 'dashboards' },
      { metric: 'errorRate', max: 100 },
    ]);
    const [merchants, dashboards, all] = r.goals;
    expect(merchants.met).toBe(true);
    expect(merchants.actual).toBeLessThan(6);
    expect(dashboards.met).toBe(false);
    expect(dashboards.actual).toBeGreaterThan(50);
    // The whole-system figure sits between the two, which is the point.
    expect(all.actual).toBeGreaterThan(merchants.actual ?? 0);
    expect(all.actual).toBeLessThan(dashboards.actual ?? 0);
    expect(r.outcome).toBe('goal-missed');
  });

  it('passes a brief that only asks for the healthy route', () => {
    const r = run([
      { metric: 'errorRate', max: 6, route: 'merchants' },
      { metric: 'p99', max: 2000, route: 'merchants' },
    ]);
    expect(r.goals.every((g) => g.met)).toBe(true);
    expect(r.outcome).toBe('passed');
  });

  it('misses a goal on a client the design does not have', () => {
    const r = run([{ metric: 'errorRate', max: 100, route: 'nobody' }]);
    expect(r.goals[0].actual).toBeNull();
    expect(r.goals[0].met).toBe(false);
  });

  it('reads the route live, as the panel shows it', () => {
    const engine = new Engine(stripe(), 1);
    for (let t = 0; t < 8000; t += 1000 / 60) engine.advance(1000 / 60);
    const live = evaluate(
      challenge([
        { metric: 'errorRate', max: 6, route: 'merchants' },
        { metric: 'errorRate', max: 1, route: 'dashboards' },
      ]),
      engine.snapshot(),
      engine.routes(),
    );
    expect(live.goals[0].met).toBe(true);
    expect(live.goals[1].met).toBe(false);
    expect(live.goals[1].actual).toBeGreaterThan(50);
    // Without route readings there is nothing to judge a route goal on.
    const blind = evaluate(
      challenge([{ metric: 'errorRate', max: 100, route: 'merchants' }]),
      engine.snapshot(),
    );
    expect(blind.goals[0].met).toBe(false);
  });

  it('leaves every existing brief as it was', () => {
    expect(CHALLENGES.flatMap((c) => c.goals).some((g) => g.route !== undefined)).toBe(
      false,
    );
    expect(isRouteGoal({ metric: 'lostJobs', max: 0, route: 'x' })).toBe(false);
  });
});

describe('route goals: the gates read the route', () => {
  // Checkout has a roomy service to itself; browsing floods a one-slot one.
  const node = (id: string, kind: 'client' | 'service', c: Record<string, number>) => ({
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...c },
  });
  const t: Topology = {
    nodes: [
      node('checkout', 'client', { rps: 20, timeoutMs: 60_000 }),
      node('browse', 'client', { rps: 400, timeoutMs: 60_000 }),
      node('api', 'service', {
        capacity: 64,
        serviceMs: 5,
        serviceCv: 0,
        queueLimit: 64,
      }),
      node('slow', 'service', {
        capacity: 1,
        serviceMs: 50,
        serviceCv: 0,
        queueLimit: 100_000,
      }),
    ],
    edges: [
      { id: 'a', from: 'checkout', to: 'api', weight: 1 },
      { id: 'b', from: 'browse', to: 'slow', weight: 1 },
    ],
  };

  it("does not fail a client's goal for another client's backlog", () => {
    const e = new Engine(t, 1);
    for (let ms = 0; ms < 5000; ms += 100) e.advance(100);
    e.startTally();
    for (let ms = 0; ms < 25_000; ms += 100) e.advance(100);
    e.stopTally();
    const tally = e.readTally();
    if (tally === null) throw new Error('no tally');
    const extras = { writes: false, jobs: false, queueDepth: null };
    const route = measureWindow(
      [{ metric: 'errorRate', max: 1, route: 'checkout' }],
      tally,
      extras,
    );
    expect(route.outcome).toBe('passed');
    expect(route.keptUp).toBe(1);
    // The system goal still sees browsing pile up.
    expect(
      measureWindow([{ metric: 'errorRate', max: 1 }], tally, extras).outcome,
    ).toBe('falling-behind');
  });
});
