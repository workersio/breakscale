import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { RouteStats } from '../sim/types';
import {
  ALERT_HIDE_AFTER_MS,
  ALERT_REFRESH_MS,
  ROUTE_ALERT_START,
  ROUTE_DWELL_MS,
  dominantReason,
  routeCondition,
  routeSentence,
  stepRouteAlert,
} from './routeHealth';
import type { RouteAlertState } from './routeHealth';

function route(clientId: string, over: Partial<RouteStats> = {}): RouteStats {
  return {
    clientId,
    offeredRps: 50,
    goodputRps: 50,
    failedRps: 0,
    errorRate: 0,
    p50: 20,
    p95: 40,
    p99: 60,
    failureRates: {},
    totalRequests: 0,
    totalCompleted: 0,
    totalFailed: 0,
    failuresByReason: {},
    history: [],
    ...over,
  };
}

/** A route losing `share` of 50 settled requests a second to `reason`. */
function failing(clientId: string, share: number, reason = 'timeout'): RouteStats {
  return route(clientId, {
    goodputRps: 50 * (1 - share),
    failedRps: 50 * share,
    errorRate: share,
    failureRates: { [reason]: 50 * share },
  });
}

const NAMES: Record<string, string> = {
  checkout: 'Checkout users',
  browse: 'Browsers',
  search: 'Searchers',
};
const nameOf = (id: string) => NAMES[id] ?? id;

describe('which route is hurting', () => {
  it('names the failing route and the fine one', () => {
    expect(routeSentence([failing('checkout', 0.4), route('browse')], nameOf)).toBe(
      'Checkout users: 40% failing, mostly timing out. Browsers: fine.',
    );
  });

  it('says nothing when everything is fine', () => {
    expect(routeSentence([route('checkout'), route('browse')], nameOf)).toBeNull();
  });

  it('says nothing with a single client, however badly it is doing', () => {
    expect(routeSentence([failing('checkout', 0.9)], nameOf)).toBeNull();
  });

  it('says nothing when every route is failing: that is not one group of users', () => {
    expect(
      routeSentence([failing('checkout', 0.4), failing('browse', 0.3)], nameOf),
    ).toBeNull();
  });

  it('leaves out an idle route and does not count it as fine', () => {
    const idle = route('browse', { offeredRps: 0, goodputRps: 0.5 });
    expect(routeCondition(idle)).toBe('idle');
    expect(routeSentence([failing('checkout', 0.4), idle], nameOf)).toBeNull();
  });

  it('needs one in ten failing, so a few percent refused on purpose stays quiet', () => {
    expect(routeCondition(failing('checkout', 0.05))).toBe('between');
    expect(routeCondition(failing('checkout', 0.1))).toBe('hurting');
    expect(routeCondition(failing('checkout', 0.009))).toBe('fine');
    expect(
      routeSentence([failing('checkout', 0.05), route('browse')], nameOf),
    ).toBeNull();
    // Beside one that is hurting, it is named with its own figure.
    expect(
      routeSentence([failing('checkout', 0.5), failing('browse', 0.05)], nameOf),
    ).toBe('Checkout users: 50% failing, mostly timing out. Browsers: 5% failing.');
  });

  it('calls a slow route hurting even when nothing fails', () => {
    const slow = route('checkout', { p99: 2300 });
    expect(routeSentence([slow, route('browse')], nameOf)).toBe(
      'Checkout users: slow, 1 in 100 requests take 2.3s or longer. Browsers: fine.',
    );
  });

  it('does not name a reason that is not most of the failures', () => {
    const mixed = route('checkout', {
      goodputRps: 30,
      failedRps: 20,
      errorRate: 0.4,
      failureRates: { timeout: 8, shed: 7, error: 5 },
    });
    expect(dominantReason(mixed)).toBeNull();
    expect(routeSentence([mixed, route('browse')], nameOf)).toBe(
      'Checkout users: 40% failing. Browsers: fine.',
    );
  });

  it('lists several, worst first, with a route in between given its own figure', () => {
    const text = routeSentence(
      [
        failing('browse', 0.2, 'shed'),
        failing('checkout', 0.6),
        failing('search', 0.03),
        route('a'),
        route('b'),
      ],
      nameOf,
    );
    expect(text).toBe(
      'Checkout users: 60% failing, mostly timing out. ' +
        'Browsers: 20% failing, mostly turned away by a full queue. ' +
        'Searchers: 3% failing. a and b: fine.',
    );
  });

  it('stays quiet on every example at its own load', () => {
    for (const p of PRESETS) {
      const engine = new Engine(p.topology, 1);
      for (let t = 0; t < 20_000; t += 1000 / 60) engine.advance(1000 / 60);
      expect(
        routeSentence(engine.routes(), (id) => id),
        p.id,
      ).toBeNull();
    }
  });

  it('speaks up on stripe once the reporting API is slowed', () => {
    const t = PRESETS.find((p) => p.id === 'stripe')?.topology;
    if (!t) throw new Error('no stripe');
    const engine = new Engine(t, 1);
    for (let s = 0; s < 5000; s += 1000 / 60) engine.advance(1000 / 60);
    engine.injectFailure('reportsvc', 'slow', { factor: 40 });
    for (let s = 0; s < 8000; s += 1000 / 60) engine.advance(1000 / 60);
    const label = (id: string) => t.nodes.find((n) => n.id === id)?.label ?? id;
    const text = routeSentence(engine.routes(), label);
    expect(text).toMatch(
      /^Dashboard Readers: 100% failing, mostly [a-z ]+\. Merchant API Calls: [\d.]+% failing\.$/,
    );
  });
});

describe('the line holds still', () => {
  const step = (
    s: RouteAlertState,
    routes: RouteStats[],
    ms: number,
  ): RouteAlertState => stepRouteAlert(s, routes, ms, nameOf);
  const fine = [route('checkout'), route('browse')];
  const bad = [failing('checkout', 0.4), route('browse')];

  it('keeps a route in its condition until it is clearly past the line', () => {
    expect(routeCondition(failing('a', 0.012))).toBe('between');
    expect(routeCondition(failing('a', 0.008), 'between')).toBe('between');
    expect(routeCondition(failing('a', 0.004), 'between')).toBe('fine');
    expect(routeCondition(failing('a', 0.09), 'hurting')).toBe('hurting');
    expect(routeCondition(failing('a', 0.09), 'between')).toBe('between');
    const trickle = route('a', { goodputRps: 0.8 });
    expect(routeCondition(trickle)).toBe('idle');
    expect(routeCondition(trickle, 'fine')).toBe('fine');
  });

  it('believes a change once it lasts, and goes once the routes agree a while', () => {
    let s = step(ROUTE_ALERT_START, fine, 0);
    s = step(s, bad, 1000);
    expect(s.shown).toBeNull();
    // A burst shorter than the dwell is not a change.
    s = step(s, fine, 1500);
    s = step(s, bad, 2000);
    expect(s.shown).toBeNull();
    s = step(s, bad, 2000 + ROUTE_DWELL_MS);
    expect(s.shown?.text).toBe(
      'Checkout users: 40% failing, mostly timing out. Browsers: fine.',
    );
    expect(s.spoken).toBe(s.shown?.text);
    s = step(s, fine, 5000);
    s = step(s, fine, 5000 + ROUTE_DWELL_MS);
    expect(s.shown).not.toBeNull();
    s = step(s, fine, 5000 + ROUTE_DWELL_MS + ALERT_HIDE_AFTER_MS);
    expect(s.shown).toBeNull();
    expect(s.spoken).toBe('');
  });

  it('refreshes its figures every so often, and speaks only when who is hurting changes', () => {
    let s = step(ROUTE_ALERT_START, bad, 0);
    const first = s.spoken;
    expect(first).toContain('40% failing');
    s = step(s, [failing('checkout', 0.5), route('browse')], 500);
    expect(s.shown?.text).toContain('40% failing');
    s = step(s, [failing('checkout', 0.5), route('browse')], ALERT_REFRESH_MS);
    expect(s.shown?.text).toContain('50% failing');
    expect(s.spoken).toBe(first);
    const both = [failing('checkout', 0.5), failing('browse', 0.03)];
    s = step(step(s, both, 3000), both, 3000 + ROUTE_DWELL_MS);
    expect(s.shown?.text).toBe(
      'Checkout users: 50% failing, mostly timing out. Browsers: 3% failing.',
    );
    expect(s.spoken).toBe(first);
  });

  it('starts again when the clock goes back', () => {
    const s = step(ROUTE_ALERT_START, bad, 5000);
    expect(s.shown).not.toBeNull();
    expect(step(s, fine, 100).shown).toBeNull();
  });
});
