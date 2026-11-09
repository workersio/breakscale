import type { FailureReason, RouteStats } from '../sim/types';
import { formatMs, formatPct, healthOfLatency } from './format';

/* ------------------------------------------------------------------ *
 * Which kind of user is hurting.
 *
 * The system figures average every client together, so checkout failing
 * 40% beside browsing failing none reads as "16% errors" and points at
 * nobody. When the routes come apart, one sentence names the one in
 * trouble and the ones that are not.
 *
 * When it shows, all of these hold:
 *  - at least two routes are ACTIVE: 1 or more of their requests settle a
 *    second. Below that a percentage is one or two requests, and an idle
 *    route has nothing to say;
 *  - at least one active route is HURTING: 1 in 10 or more of its
 *    requests fail, or its p99 is 1s or more. The bar is higher than the
 *    5% the error readouts turn red at because some designs fail a few
 *    percent on purpose (Stripe's gateway refuses 5% of merchant calls as
 *    unauthorised), and a sentence that is always there stops being read;
 *  - at least one active route is NOT hurting.
 *
 * The hurting routes come first, worst first, each with its share failing
 * and the reason behind most of it, or its p99 when it is slow rather than
 * failing. Then the rest: the FINE ones (under 1% failing, p99 under 1s)
 * together as "fine", and any in between with their own share failing.
 *
 * Everything hurting is not a difference between users, and the system
 * figures already say it, so the sentence stays away. So does nothing
 * hurting.
 * ------------------------------------------------------------------ */

/** Settled requests a second below which a route counts as idle. */
export const ROUTE_ACTIVE_RPS = 1;
/** Share failing at or above which a route is hurting. */
export const ROUTE_HURT_ERR = 0.1;
/** Share failing below which a route is fine. */
export const ROUTE_FINE_ERR = 0.01;

export type RouteCondition = 'idle' | 'fine' | 'hurting' | 'between';

/*
 * A route near a line would flip across it with every reading, so once it
 * has a condition it keeps it until it is clearly past the line the other
 * way: idle again below half the active rate, no longer hurting below 8%
 * failing and a p99 under 800ms, and fine again below 0.5% failing. Fine
 * still always means under 1%.
 */
const IDLE_AGAIN_RPS = 0.5;
const HURT_AGAIN_ERR = 0.08;
const SLOW_AGAIN_MS = 800;
const FINE_AGAIN_ERR = 0.005;

/**
 * A route's condition, from its figures and, when given, the one it had
 * at the last reading.
 */
export function routeCondition(r: RouteStats, prev?: RouteCondition): RouteCondition {
  const settled = r.goodputRps + r.failedRps;
  const wasActive = prev !== undefined && prev !== 'idle';
  if (settled < (wasActive ? IDLE_AGAIN_RPS : ROUTE_ACTIVE_RPS)) return 'idle';
  const slow =
    r.goodputRps > 0 &&
    (prev === 'hurting' ? r.p99 >= SLOW_AGAIN_MS : healthOfLatency(r.p99) === 'danger');
  if (r.errorRate >= (prev === 'hurting' ? HURT_AGAIN_ERR : ROUTE_HURT_ERR) || slow) {
    return 'hurting';
  }
  return r.errorRate < (prev === 'between' ? FINE_AGAIN_ERR : ROUTE_FINE_ERR)
    ? 'fine'
    : 'between';
}

/** How a route's failures read after "mostly". */
const MOSTLY: Record<FailureReason, string> = {
  timeout: 'timing out',
  shed: 'turned away by a full queue',
  error: 'answered with errors',
  'no-route': 'finding nowhere to go',
  depth: 'going round in a loop',
  throttled: 'held back by a rate limiter',
  rejected: 'refused by an open circuit breaker',
  crashed: 'hitting a crashed component',
  partitioned: 'stopped by a cut network link',
  'region-down': 'finding no region serving',
  'conn-refused': 'refused a connection',
  unauthorized: 'failing to sign in',
  'bulkhead-full': 'refused by a full bulkhead',
  'acquire-timeout': 'waiting too long for a free slot',
  deprioritized: 'dropped to protect other traffic',
  'packet-loss': 'lost on the network',
};

/** The reason behind at least half of a route's failures, if one is. */
export function dominantReason(r: RouteStats): FailureReason | null {
  let best: FailureReason | null = null;
  let bestRate = 0;
  let total = 0;
  for (const [reason, rate] of Object.entries(r.failureRates) as [
    FailureReason,
    number,
  ][]) {
    total += rate;
    if (rate > bestRate) {
      best = reason;
      bestRate = rate;
    }
  }
  return total > 0 && bestRate * 2 >= total ? best : null;
}

/** "A", "A and B", "A, B and C". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What is wrong with one hurting route, after its name. */
function trouble(r: RouteStats): string {
  if (r.errorRate >= ROUTE_HURT_ERR) {
    const why = dominantReason(r);
    const failing = `${formatPct(r.errorRate)} failing`;
    return why ? `${failing}, mostly ${MOSTLY[why]}` : failing;
  }
  return `slow, 1 in 100 requests take ${formatMs(r.p99)} or longer`;
}

/** Worst first: by share failing, then by p99. */
function worse(a: RouteStats, b: RouteStats): number {
  return b.errorRate - a.errorRate || b.p99 - a.p99;
}

/**
 * The sentence, or null when it should not show. `nameOf` turns a client id
 * into the label on its card; `conditions` holds each route's condition
 * when the caller has already settled them.
 */
export function routeSentence(
  routes: readonly RouteStats[],
  nameOf: (clientId: string) => string,
  conditions?: Readonly<Record<string, RouteCondition>>,
): string | null {
  const hurting: RouteStats[] = [];
  const between: RouteStats[] = [];
  const fine: string[] = [];
  for (const r of routes) {
    const c = conditions?.[r.clientId] ?? routeCondition(r);
    if (c === 'hurting') hurting.push(r);
    else if (c === 'between') between.push(r);
    else if (c === 'fine') fine.push(nameOf(r.clientId));
  }
  if (hurting.length === 0 || between.length + fine.length === 0) return null;
  hurting.sort(worse);
  between.sort(worse);
  const parts = hurting.map((r) => `${nameOf(r.clientId)}: ${trouble(r)}.`);
  for (const r of between) {
    parts.push(`${nameOf(r.clientId)}: ${formatPct(r.errorRate)} failing.`);
  }
  if (fine.length > 0) parts.push(`${list(fine)}: fine.`);
  return parts.join(' ');
}

/* ---------------- holding the line steady ---------------- */

/**
 * Simulated ms a route has to stay in a new condition before the line
 * believes it. Traffic comes in bursts: a route failing 0% one reading and
 * 1.4% the next is one condition, not two.
 */
export const ROUTE_DWELL_MS = 2000;
/** Simulated ms the routes have to agree again before the line goes. */
export const ALERT_HIDE_AFTER_MS = 2000;
/** Simulated ms between updates of its figures while nothing else changes. */
export const ALERT_REFRESH_MS = 2000;

export interface RouteAlertState {
  /** Simulated ms of the last reading. */
  atMs: number;
  /** Each route's condition, once it has lasted. */
  conditions: Readonly<Record<string, RouteCondition>>;
  /** A condition a route has moved to, and since when, until it lasts. */
  moving: Readonly<Record<string, { to: RouteCondition; sinceMs: number }>>;
  /** When the routes stopped differing, while the line waits to go. */
  clearSince: number | null;
  /** The line on screen: which routes are in which condition, and when it was written. */
  shown: { key: string; text: string; atMs: number } | null;
  /**
   * What a screen reader is given: the line as it was when it appeared or
   * when which routes are hurting changed, not every new percentage.
   */
  spoken: string;
}

export const ROUTE_ALERT_START: RouteAlertState = {
  atMs: -1,
  conditions: {},
  moving: {},
  clearSince: null,
  shown: null,
  spoken: '',
};

/** The line's next state, from the routes at simulated time `nowMs`. */
export function stepRouteAlert(
  prev: RouteAlertState,
  routes: readonly RouteStats[],
  nowMs: number,
  nameOf: (clientId: string) => string,
): RouteAlertState {
  // A reset rewinds the clock; start again rather than hold an old line.
  const from = nowMs < prev.atMs ? ROUTE_ALERT_START : prev;
  const conditions: Record<string, RouteCondition> = {};
  const moving: Record<string, { to: RouteCondition; sinceMs: number }> = {};
  for (const r of routes) {
    const id = r.clientId;
    const was = from.conditions[id];
    const now = routeCondition(r, was);
    if (was === undefined || now === was) {
      conditions[id] = now;
      continue;
    }
    const since = from.moving[id]?.to === now ? from.moving[id].sinceMs : nowMs;
    if (nowMs - since >= ROUTE_DWELL_MS) conditions[id] = now;
    else {
      conditions[id] = was;
      moving[id] = { to: now, sinceMs: since };
    }
  }
  const text = routeSentence(routes, nameOf, conditions);
  const next: RouteAlertState = { ...from, atMs: nowMs, conditions, moving };
  if (text === null) {
    if (from.shown === null) return next;
    next.clearSince = from.clearSince ?? nowMs;
    if (nowMs - next.clearSince >= ALERT_HIDE_AFTER_MS) {
      next.shown = null;
      next.clearSince = null;
      next.spoken = '';
    }
    return next;
  }
  next.clearSince = null;
  // What a listener needs to hear again for: a different set of routes hurting.
  const key = routes
    .filter((r) => conditions[r.clientId] === 'hurting')
    .map((r) => r.clientId)
    .sort()
    .join('|');
  if (from.shown === null || key !== from.shown.key) {
    next.shown = { key, text, atMs: nowMs };
    next.spoken = text;
  } else if (nowMs - from.shown.atMs >= ALERT_REFRESH_MS) {
    next.shown = { key, text, atMs: nowMs };
  }
  return next;
}
