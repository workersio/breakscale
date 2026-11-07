/**
 * Edge-protection component behaviours: cdn, ratelimiter, breaker.
 *
 * These three are the layer that sits in FRONT of a system and decides what
 * ever reaches it. Grouped in their own module because they share a theme a
 * student can name -- "how do I stop load before it hurts me" -- and because
 * keeping them out of behaviour.ts keeps that file readable as the kind count
 * grows.
 *
 * Every one of them is a plain ComponentBehaviour: the event loop has no idea
 * they exist. None of them added a conditional to engine.ts.
 *
 * A note on determinism, which constrains all three. `advance(dt)` is driven
 * by wall-clock frames, so dt varies from frame to frame. Anything that
 * decides "has enough time passed?" therefore has to compare *simulated
 * timestamps*, never accumulate per-tick deltas -- otherwise the same seed
 * produces different results at a different frame rate. That is why the token
 * bucket refills against `now - lastRefillMs` and the breaker's state
 * transitions are evaluated lazily when a request arrives, rather than from
 * onTick.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/* ------------------------------------------------------------------ *
 * cdn
 * ------------------------------------------------------------------ */

/**
 * A content delivery network edge cache.
 *
 * Mechanically this is a cache that sits geographically in front of
 * everything: `serviceMs` is tiny (you are talking to a nearby PoP, not the
 * origin) and `hitRate` is high. The teaching point is entirely in what the
 * numbers do to the rest of the topology -- at hitRate 0.9 the origin sees a
 * tenth of the offered load, so the CDN is doing 90% of the work of ten extra
 * servers for none of the cost.
 *
 * The one behavioural difference from `cache`: a miss here is expensive,
 * because the origin is far away. That falls out naturally rather than being
 * special-cased -- the miss goes downstream and pays whatever the origin path
 * costs, including any edge latency wired onto the link.
 */
const cdn: ComponentBehaviour = {
  kind: 'cdn',
  // An event-driven edge: the origin fetch is the caller's wait.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  onServiceComplete: (ctx, state, _req) => {
    // One RNG draw, unconditionally, in a fixed position. Drawing only on
    // some paths would make the stream depend on config and break replay.
    if (ctx.roll() < clamp01(state.config.hitRate)) {
      ctx.countHit(state);
      return 'complete';
    }
    ctx.countMiss(state);
    // A miss must be fetched from origin. Book it separately from the generic
    // miss counter so the UI can show origin load in requests/sec -- "what
    // actually reached your servers" is the number worth teaching.
    ctx.countCustom(state, 'originFetch', 1);
    // Nothing behind the CDN: it still answers, it just cannot demonstrate
    // the origin-offload lesson.
    return state.out.length === 0 ? 'complete' : 'downstream';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    stats.originFetchRate = ctx.counterRate(state, 'originFetch');
  },
};

/* ------------------------------------------------------------------ *
 * ratelimiter
 * ------------------------------------------------------------------ */

/** Token bucket state. */
interface BucketState {
  /** Tokens available right now. Fractional: refill is continuous. */
  tokens: number;
  /** Simulated time the bucket was last refilled, in ms. */
  lastRefillMs: number;
  /** Bucket size the tokens were last capped against, to detect a config change. */
  lastBurst: number;
}

/** `rateLimitRps`, defaulted and floored to something sane. */
function limitRate(state: NodeStateLike): number {
  const r = state.config.rateLimitRps;
  return r !== undefined && r > 0 ? r : 0;
}

/** Bucket size in tokens. Defaults to one second's worth of rate. */
function limitBurst(state: NodeStateLike): number {
  const b = state.config.burst;
  if (b !== undefined && b > 0) return b;
  const r = limitRate(state);
  return r > 0 ? r : 1;
}

/**
 * Bring the bucket up to date with the current simulated time.
 *
 * Refill is computed from elapsed simulated ms, NOT accumulated per tick.
 * This is what makes the limiter exact: over T seconds it grants exactly
 * rate*T tokens regardless of how many advance() calls that T was split
 * across, so a 16ms frame and a 100ms frame produce identical admissions.
 * A per-tick `tokens += rate * dt` would drift with frame rate and, worse,
 * would make the sim non-deterministic against a variable frame clock.
 */
function refill(ctx: BehaviourCtx, state: NodeStateLike, b: BucketState): void {
  const burst = limitBurst(state);

  // The student moved the burst slider. Re-cap rather than letting a bucket
  // filled under the old ceiling stay oversized forever.
  if (burst !== b.lastBurst) {
    if (b.tokens > burst) b.tokens = burst;
    b.lastBurst = burst;
  }

  const elapsed = ctx.now - b.lastRefillMs;
  if (elapsed <= 0) return;
  b.lastRefillMs = ctx.now;

  const rate = limitRate(state);
  if (rate <= 0) return;

  b.tokens += (elapsed / 1000) * rate;
  if (b.tokens > burst) b.tokens = burst;
}

/**
 * The bucket level as of `ctx.now`, WITHOUT mutating it.
 *
 * Same arithmetic as refill(), used for reporting only. Kept separate so
 * there is no way for a snapshot to accidentally advance the bucket: the
 * engine may be snapshotted many times between two arrivals, and each of
 * those must be a pure read.
 */
function projectedTokens(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  b: BucketState,
): number {
  const burst = limitBurst(state);
  let tokens = b.tokens > burst ? burst : b.tokens;
  const rate = limitRate(state);
  const elapsed = ctx.now - b.lastRefillMs;
  if (rate > 0 && elapsed > 0) {
    tokens += (elapsed / 1000) * rate;
    if (tokens > burst) tokens = burst;
  }
  return tokens;
}

/**
 * A token bucket in front of whatever it fronts.
 *
 * Every request costs one token. A request that finds the bucket empty is
 * refused immediately as 'throttled' -- it never queues, never occupies a
 * slot, and never touches downstream. That cheapness is the whole point: the
 * lesson is that refusing 400 rps at the door costs almost nothing, whereas
 * accepting them and letting them queue is what actually takes the system
 * down. A student can watch the same offered load produce a healthy service
 * with a limiter and a collapsed one without.
 *
 * Zero RNG draws, so a limiter never perturbs the random stream.
 */
const ratelimiter: ComponentBehaviour = {
  kind: 'ratelimiter',
  // A gate with no slots: it decides and hands the request on.
  blocksOnDownstream: false,
  // A limiter is a doorman, not a server: it holds no slots and its
  // utilisation would be meaningless, so it reports none.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: (state): BucketState => ({
    // A fresh limiter starts FULL, so an idle system absorbs one full burst
    // instantly -- which is exactly the behaviour a token bucket is chosen
    // for, and the first thing worth demonstrating.
    tokens: limitBurst(state),
    lastRefillMs: 0,
    lastBurst: limitBurst(state),
  }),

  onAdmit: (ctx, state, req) => {
    const b = state.ext as BucketState;
    refill(ctx, state, b);

    // rate <= 0 means "no limit configured": pass everything rather than
    // silently black-holing the topology a student just wired up.
    if (limitRate(state) <= 0) {
      ctx.countCustom(state, 'admitted', 1);
      return 'passthru';
    }

    if (b.tokens >= 1) {
      b.tokens -= 1;
      ctx.countCustom(state, 'admitted', 1);
      return 'passthru';
    }

    ctx.countCustom(state, 'throttled', 1);
    ctx.reject(state, req, 'throttled');
    return 'handled';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const b = state.ext as BucketState | null;
    stats.admittedRate = ctx.counterRate(state, 'admitted');
    stats.throttledRate = ctx.counterRate(state, 'throttled');
    // Report the bucket as of NOW, not as of the last arrival. Refill is
    // lazy -- b.tokens is only brought up to date when a request turns up --
    // so reading the stored value straight out would show an idle limiter's
    // bucket frozen instead of visibly filling, and would misreport by up to
    // rate*(now - lastRefill) whenever traffic is sparse. Computed here
    // rather than by calling refill(), because snapshot() must not mutate
    // simulation state: taking a snapshot has to be observation only.
    stats.tokens = b ? projectedTokens(ctx, state, b) : 0;
  },
};

/* ------------------------------------------------------------------ *
 * breaker
 * ------------------------------------------------------------------ */

export type BreakerPhase = 'closed' | 'open' | 'half-open';

/** How many buckets the trailing error window is split into. */
const BREAKER_BUCKETS = 10;

/** Circuit breaker state. */
interface BreakerState {
  phase: BreakerPhase;
  /** Simulated time the circuit last tripped OPEN, in ms. */
  openedAtMs: number;
  /** Probes already admitted in the current HALF-OPEN attempt. */
  probesSent: number;
  /** Probes that came back successful in the current HALF-OPEN attempt. */
  probesOk: number;
  /** Rolling window of downstream outcomes: total calls per bucket. */
  total: Float64Array;
  /** Rolling window of downstream outcomes: failed calls per bucket. */
  failed: Float64Array;
  /** Bucket index stamps, so a stale bucket is zeroed rather than summed. */
  stamps: Float64Array;
  /** Times the circuit has tripped OPEN since sim start. */
  trips: number;
}

function cfgErrorThreshold(state: NodeStateLike): number {
  const v = state.config.errorThreshold;
  return v !== undefined ? clamp01(v) : 0.5;
}
function cfgWindowMs(state: NodeStateLike): number {
  const v = state.config.windowMs;
  return v !== undefined && v > 0 ? v : 5000;
}
function cfgOpenMs(state: NodeStateLike): number {
  const v = state.config.openMs;
  return v !== undefined && v > 0 ? v : 3000;
}
function cfgHalfOpenProbes(state: NodeStateLike): number {
  const v = state.config.halfOpenProbes;
  return v !== undefined && v >= 1 ? Math.floor(v) : 3;
}

/** Which bucket of the trailing window a timestamp falls in. */
function bucketOf(now: number, windowMs: number): number {
  return Math.floor(now / (windowMs / BREAKER_BUCKETS));
}

/**
 * Record one downstream outcome into the trailing window.
 *
 * Bucketed rather than a list of timestamps so memory is O(1) per breaker
 * however much traffic flows through it -- a breaker in front of a 10k rps
 * service must not accumulate 10k entries per second.
 */
function recordOutcome(
  b: BreakerState,
  now: number,
  windowMs: number,
  ok: boolean,
): void {
  const stamp = bucketOf(now, windowMs);
  const idx = ((stamp % BREAKER_BUCKETS) + BREAKER_BUCKETS) % BREAKER_BUCKETS;
  if (b.stamps[idx] !== stamp) {
    // This slot belongs to an older revolution of the window: reset it rather
    // than adding to counts from `windowMs` ago.
    b.stamps[idx] = stamp;
    b.total[idx] = 0;
    b.failed[idx] = 0;
  }
  b.total[idx] += 1;
  if (!ok) b.failed[idx] += 1;
}

/** Failed/total over the trailing window, plus the total, for the trip test. */
function windowStats(
  b: BreakerState,
  now: number,
  windowMs: number,
): { rate: number; total: number } {
  const current = bucketOf(now, windowMs);
  let total = 0;
  let failed = 0;
  for (let i = 0; i < BREAKER_BUCKETS; i++) {
    const age = current - b.stamps[i];
    // age === 0 is the bucket still filling and IS counted here, unlike the
    // engine's display rates: a breaker must react to what is happening right
    // now, not wait a bucket for it to become official.
    if (age >= 0 && age < BREAKER_BUCKETS) {
      total += b.total[i];
      failed += b.failed[i];
    }
  }
  return { rate: total > 0 ? failed / total : 0, total };
}

/** Clear the window. Used whenever the circuit changes phase. */
function clearWindow(b: BreakerState): void {
  b.total.fill(0);
  b.failed.fill(0);
  b.stamps.fill(-1);
}

/**
 * Minimum downstream calls in the window before the breaker will trip.
 *
 * Without this a single unlucky failure at t=0 is a 100% error rate and the
 * circuit trips on a sample of one. Real breakers all have this guard; it is
 * also what stops the sim looking broken the instant a student adds a node
 * with a small errorRate.
 */
const BREAKER_MIN_SAMPLES = 5;

/**
 * A circuit breaker wrapping its downstream.
 *
 * CLOSED     -> pass everything, watch the downstream error rate.
 * OPEN       -> fail fast as 'rejected'. Downstream receives NOTHING.
 * HALF-OPEN  -> admit exactly `halfOpenProbes` requests. All succeed -> CLOSED.
 *               Any one fails -> straight back to OPEN.
 *
 * The teaching point is what OPEN does for the *dependency*: a service that
 * is falling over because it is overwhelmed cannot recover while its caller
 * keeps hammering it. Cutting the traffic to zero for openMs is what gives it
 * room to come back. A student can watch the downstream's queue drain during
 * the OPEN window and see it recover -- and then remove the breaker and watch
 * it never recover at all.
 *
 * State transitions are evaluated lazily, at admission, by comparing
 * simulated timestamps. Doing this from onTick would tie the transition
 * instant to the frame cadence and lose determinism.
 */
const breaker: ComponentBehaviour = {
  kind: 'breaker',
  // A gate with no slots: it decides and hands the request on.
  blocksOnDownstream: false,
  // Like the limiter, a pass-through gate rather than a server.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,
  // The whole point: it needs to see how its dependency is doing.
  observesOutcome: true,

  initState: (): BreakerState => ({
    phase: 'closed',
    openedAtMs: 0,
    probesSent: 0,
    probesOk: 0,
    total: new Float64Array(BREAKER_BUCKETS),
    failed: new Float64Array(BREAKER_BUCKETS),
    stamps: new Float64Array(BREAKER_BUCKETS).fill(-1),
    trips: 0,
  }),

  onAdmit: (ctx, state, req) => {
    const b = state.ext as BreakerState;

    // Lazy transition: OPEN has served its time, start probing.
    if (b.phase === 'open' && ctx.now - b.openedAtMs >= cfgOpenMs(state)) {
      b.phase = 'half-open';
      b.probesSent = 0;
      b.probesOk = 0;
    }

    if (b.phase === 'open') {
      // Fail fast. No downstream call is made at all -- this is the entire
      // value of the component, and it is why the check lives in onAdmit
      // rather than in route(): by the time route() runs the request has
      // already been admitted and costed.
      ctx.countCustom(state, 'rejected', 1);
      ctx.reject(state, req, 'rejected');
      return 'handled';
    }

    if (b.phase === 'half-open') {
      // Only a fixed number of probes are allowed through; everything else is
      // still refused, so a recovering dependency gets a trickle rather than
      // the full firehose the instant the timer expires.
      if (b.probesSent >= cfgHalfOpenProbes(state)) {
        ctx.countCustom(state, 'rejected', 1);
        ctx.reject(state, req, 'rejected');
        return 'handled';
      }
      b.probesSent++;
    }

    ctx.countCustom(state, 'admitted', 1);
    return 'passthru';
  },

  onDownstreamResult: (ctx, state, _req, ok, _reason) => {
    const b = state.ext as BreakerState;

    if (b.phase === 'half-open') {
      if (!ok) {
        // One failed probe is enough: the dependency is still sick. Back to
        // OPEN for another full openMs.
        b.phase = 'open';
        b.openedAtMs = ctx.now;
        b.trips++;
        clearWindow(b);
        return;
      }
      b.probesOk++;
      if (b.probesOk >= cfgHalfOpenProbes(state)) {
        // Every probe came back clean: the dependency is healthy again.
        b.phase = 'closed';
        clearWindow(b);
      }
      return;
    }

    if (b.phase !== 'closed') return;

    const windowMs = cfgWindowMs(state);
    recordOutcome(b, ctx.now, windowMs, ok);

    const { rate, total } = windowStats(b, ctx.now, windowMs);
    if (total >= BREAKER_MIN_SAMPLES && rate > cfgErrorThreshold(state)) {
      b.phase = 'open';
      b.openedAtMs = ctx.now;
      b.trips++;
      // Drop the evidence that tripped it. Keeping it would make the breaker
      // re-trip instantly on its first probe failure's stale company.
      clearWindow(b);
    }
  },

  /**
   * An OPEN breaker's downstream edge is carrying nothing, and it is carrying
   * nothing for a REASON -- the component is doing its job. Reporting it as
   * 'blocked' is what lets the canvas draw that wire severed instead of merely
   * quiet, which is the difference between a student seeing the breaker work
   * and seeing a link that looks identical to an idle one.
   *
   * HALF-OPEN is deliberately NOT blocked: a trickle of probes really is
   * crossing, and drawing it cut would contradict the traffic on it.
   */
  edgeStateFor: (ctx, state, _edge, _index) => {
    const b = state.ext as BreakerState | null;
    if (!b) return null;
    // Same lazy transition decorateStats reports, so the wire and the badge
    // never disagree: a circuit whose openMs has elapsed is already probing.
    const open = b.phase === 'open' && ctx.now - b.openedAtMs < cfgOpenMs(state);
    return open ? 'blocked' : null;
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const b = state.ext as BreakerState | null;
    if (!b) return;
    // Report the phase the breaker would act on if a request arrived right
    // now, so the UI never shows OPEN for a circuit whose timer has expired.
    const phase =
      b.phase === 'open' && ctx.now - b.openedAtMs >= cfgOpenMs(state)
        ? 'half-open'
        : b.phase;
    stats.breakerState = phase;
    stats.breakerErrorRate = windowStats(b, ctx.now, cfgWindowMs(state)).rate;
    stats.rejectedRate = ctx.counterRate(state, 'rejected');
    stats.breakerTrips = b.trips;
    // Countdown to the half-open probe, on exactly the phase that has one.
    stats.openRemainingMs =
      phase === 'open' ? Math.max(0, cfgOpenMs(state) - (ctx.now - b.openedAtMs)) : 0;
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const EDGE_BEHAVIOURS: ComponentBehaviour[] = [cdn, ratelimiter, breaker];

/* Re-exported for the verification harness; not used by the engine. */
export type { BucketState, BreakerState };
export { limitBurst, limitRate };
export type { BehaviourCtx, NodeStateLike, ReqLike };
