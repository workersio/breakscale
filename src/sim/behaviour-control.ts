/**
 * Control-plane component behaviours: autoscaler, region.
 *
 * These two are different in kind from everything else in the registry. A
 * service, a cache, a queue are all things a request passes THROUGH. These are
 * things that act ON the topology: an autoscaler writes another node's
 * capacity, a region node decides which downstream is allowed to exist right
 * now. They are the control plane, and grouping them says so.
 *
 * Both are plain ComponentBehaviour objects. The event loop has no idea they
 * exist and neither added a conditional to engine.ts.
 *
 * A note on determinism, which shapes both. `advance(dt)` is driven by
 * wall-clock frames, so dt varies frame to frame. Anything asking "has enough
 * time passed?" must compare *simulated timestamps* rather than accumulate
 * per-tick deltas, or the same seed yields different results at a different
 * frame rate. That is why the autoscaler stores `lastDecisionMs` and
 * `warmupDueMs` as absolute simulated times and ignores its own `dtMs`
 * argument entirely, and why the region node's failover deadline is an
 * absolute time evaluated lazily when a request arrives.
 *
 * Neither behaviour draws from the RNG. A controller that consumed random
 * numbers would shift the shared random stream for every other node depending
 * on how often it happened to act, which is exactly the kind of coupling that
 * makes a "deterministic" simulator quietly non-reproducible.
 */
import type { NodeConfig, NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike } from './engine-types';
import type { ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/* ------------------------------------------------------------------ *
 * autoscaler
 * ------------------------------------------------------------------ */

/**
 * Utilisation band below `targetUtil` inside which the controller does
 * nothing. Without it the controller flaps by one step every cooldown while
 * utilisation sits naturally just under its setpoint.
 */
const DEAD_BAND = 0.1;

/**
 * Fallbacks for the optional config knobs, so an unset field is never NaN.
 *
 * The timings are chosen so a student dragging the load slider sees the whole
 * story inside a few seconds of watching -- see the note on `warmupMs` in
 * presets.ts for the measured timeline.
 */
const DEFAULT_TARGET_UTIL = 0.7;
const DEFAULT_MIN_INSTANCES = 1;
const DEFAULT_MAX_INSTANCES = 64;
const DEFAULT_COOLDOWN_MS = 5000;
const DEFAULT_STEP_PCT = 0.5;
const DEFAULT_WARMUP_MS = 0;

/**
 * One optional knob, or its fallback.
 *
 * `??` delivers the promise above for an UNSET field and not for one set to
 * something that is not a number, and none of these knobs is among the nine
 * config numbers `isTopology` checks -- so a shared link, a `.breakscale`
 * file and a restored session can all hand the controller a NaN. NaN then
 * survives `Math.floor`, `Math.max` and `clamp01` alike, because it fails
 * every comparison those are written from, and the controller stops
 * controlling.
 */
function knob(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/**
 * The fewest and most instances an autoscaler will run its node at.
 *
 * The ceiling is never below the floor: a floor set above the ceiling wins, so
 * a controller set to "never below 4, never above 1" runs four machines. The
 * challenge budget prices an autoscaled node from this, so it has to be the
 * same arithmetic the controller uses.
 */
export function fleetBounds(cfg: NodeConfig): { min: number; max: number } {
  const min = Math.max(1, Math.floor(knob(cfg.minCapacity, DEFAULT_MIN_INSTANCES)));
  const max = Math.max(min, Math.floor(knob(cfg.maxCapacity, DEFAULT_MAX_INSTANCES)));
  return { min, max };
}

interface AutoscalerState {
  /** Simulated time of the last decision; -Infinity means "never decided". */
  lastDecisionMs: number;
  /**
   * Instance count the controller believes the watched node should have.
   * Tracked separately from the node's live count because during a warm-up
   * the two deliberately disagree, and that gap is the thing worth showing.
   */
  targetInstances: number;
  /**
   * Simulated time at which a pending scale-UP lands, or -1 when nothing is
   * warming up. Holding a granted decision here instead of applying it at once
   * is the entire point of this component.
   */
  warmupDueMs: number;
  /** Instance count to write when the warm-up completes. */
  pendingInstances: number;
  /** Node being driven, resolved from the controller's first out edge. */
  watchedId: string;
  /**
   * Simulated time the controller may take its FIRST decision about the
   * current target, or -1 once it has taken one.
   *
   * Utilisation is a smoothed average, so at t=0 -- and for a moment after
   * the controller is pointed at a new node -- it reads near zero no matter
   * how loaded that node actually is. Acting on that cold reading makes the
   * controller's opening move a scale-DOWN to minCapacity on a node that is
   * in fact saturated, which then takes several warm-ups to undo. A real
   * autoscaler will not act until it has a full metric window, and this is
   * that rule: observe for one cooldown, then decide.
   */
  observeUntilMs: number;
}

function asAutoscaler(state: NodeStateLike): AutoscalerState | null {
  return (state.ext as AutoscalerState | null) ?? null;
}

/**
 * A fleet controller: it adds and removes INSTANCES.
 *
 * It sits BESIDE the node it scales rather than in front of it, joined to it
 * by a CONTROL EDGE that carries no requests -- the engine keeps control
 * edges out of routing entirely, so a request can never be dispatched down
 * one. Once per `cooldownMs` it compares the watched node's utilisation
 * against `targetUtil` and steps its instance count by `scaleStepPct`,
 * clamped to [minCapacity, maxCapacity] instances.
 *
 * WHAT IT WRITES, AND WHY THAT CHANGED. It used to write the watched node's
 * `capacity` -- its thread count. That was numerically fine and pedagogically
 * useless: "traffic went up so we added threads" is not the sentence anyone
 * means, and because nothing on the canvas counted threads, the controller
 * appeared to do nothing at all. It now writes `instances`, so the drawn
 * stack of machines grows by exactly the number of machines it decided to
 * add. `capacity` -- how big one machine is -- belongs to the student and the
 * controller never touches it.
 *
 * The teaching point is the lag. A scale-UP does not take effect until
 * `warmupMs` after the decision -- machines boot, images pull, JITs warm --
 * so a student who steps the load up watches utilisation pin at 1.0, and the
 * queue build behind it, for a visible interval before capacity answers. And
 * because the controller reacts to a utilisation its own past decisions
 * caused, a short cooldown against a long warmup makes it overshoot and
 * oscillate. That is a real failure mode, and being able to reproduce it on
 * purpose is worth more than a controller that always behaves.
 *
 * Scale-DOWN is immediate, as it is in reality: releasing a machine needs no
 * warm-up. This asymmetry is deliberate and is itself part of why autoscalers
 * oscillate downward faster than they recover.
 */
const autoscaler: ComponentBehaviour = {
  kind: 'autoscaler',
  // It acts on its target and serves nothing.
  blocksOnDownstream: false,
  // A controller is not in the request path: it serves nothing, holds nothing,
  // and reports no utilisation of its own. Marking it servesRequests:false is
  // what keeps its (permanently zero) slot count out of the utilisation
  // integration, so it renders as a control box rather than an idle server.
  servesRequests: false,
  generatesLoad: false,
  // Every edge out of an autoscaler names the node it drives, never a hop.
  // The engine reads this at wiring time and leaves those edges out of the
  // routing set, so "requests are never routed down a control edge" is a
  // structural property rather than something enforced request by request.
  controlsTarget: true,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,

  initState: (): AutoscalerState => ({
    lastDecisionMs: -Infinity,
    targetInstances: 0,
    warmupDueMs: -1,
    pendingInstances: 0,
    watchedId: '',
    observeUntilMs: -1,
  }),

  /**
   * Traffic reaching an autoscaler means the student wired requests INTO the
   * controller -- which now takes deliberate effort, since the edges the
   * controller itself owns are control edges and carry nothing. Refusing
   * explicitly is far more legible than serving it, which would make the
   * controller look like a hop that mysteriously adds latency.
   */
  onAdmit: (ctx, state, req) => {
    ctx.reject(state, req, 'no-route');
    return 'handled';
  },

  /**
   * `dtMs` is deliberately unused: every decision compares absolute simulated
   * timestamps, so the controller behaves identically at any frame rate.
   */
  onTick: (ctx, state) => {
    const st = asAutoscaler(state);
    if (!st) return;

    // The watched node is whatever this controller points at, re-resolved each
    // tick so rewiring the edge on the canvas retargets it live. Its target
    // arrives on a CONTROL edge, which is a separate list from `out` precisely
    // because it is not a traffic path.
    const watched = ctx.controlTargetOf(state);
    if (watched !== st.watchedId) {
      st.watchedId = watched;
      // A new target invalidates every decision made about the old one.
      st.warmupDueMs = -1;
      st.targetInstances = 0;
      st.lastDecisionMs = -Infinity;
      // ...and starts a fresh observation window, because the new node's
      // smoothed utilisation is not a signal yet.
      st.observeUntilMs =
        ctx.now + Math.max(0, knob(state.config.cooldownMs, DEFAULT_COOLDOWN_MS));
    }
    if (watched === '') return;

    // How many instances the target is running. Null means the target is a
    // kind with no fleet to move (a queue, a breaker): the controller stays
    // put rather than ramping a number nothing reads.
    const liveInstances = ctx.scaleOf(watched);
    if (liveInstances === null) return;

    // First tick: adopt what the node already has, so the controller never
    // yanks the fleet to a default the student did not ask for.
    if (st.targetInstances === 0) st.targetInstances = liveInstances;

    // A pending scale-up whose warm-up elapsed becomes real capacity now.
    if (st.warmupDueMs >= 0 && ctx.now >= st.warmupDueMs) {
      st.warmupDueMs = -1;
      st.targetInstances = st.pendingInstances;
      ctx.setScale(watched, st.pendingInstances);
    }

    // A scale-up already booked and still warming up blocks further decisions.
    //
    // Without this the controller re-derives the same "scale up" verdict on
    // every cooldown -- utilisation is still high, because the capacity it
    // ordered has not arrived yet -- and each re-decision pushes warmupDueMs
    // forward by another full warmup. The pending capacity then never lands at
    // all, and the node stays at its original size forever. A real autoscaler
    // has exactly this problem and solves it the same way: it does not issue a
    // second order while the first is still being fulfilled.
    if (st.warmupDueMs >= 0) return;

    const cfg = state.config;
    const cooldown = Math.max(0, knob(cfg.cooldownMs, DEFAULT_COOLDOWN_MS));

    // Hold off until the watched node's utilisation is a real measurement
    // rather than an average still climbing out of its initial zero.
    if (st.observeUntilMs >= 0) {
      if (ctx.now < st.observeUntilMs) return;
      st.observeUntilMs = -1;
    }

    if (ctx.now - st.lastDecisionMs < cooldown) return;

    // A crashed node reports whatever utilisation it held when it died, which
    // is not a signal. Acting on it would either spin capacity up against a
    // dead box or scale it away just before it recovers.
    if (ctx.isCrashed(watched)) return;

    const util = ctx.utilizationOf(watched);
    if (util === null) return;

    // minCapacity/maxCapacity keep their field names for compatibility, but
    // the unit they bound is now INSTANCES -- the fleet size, not the thread
    // count. For every topology written before instances existed the two
    // readings coincide, because those nodes run exactly one instance.
    const { min: minInst, max: maxInst } = fleetBounds(cfg);
    const target = clamp01(knob(cfg.targetUtil, DEFAULT_TARGET_UTIL));
    const step = Math.max(0.01, knob(cfg.scaleStepPct, DEFAULT_STEP_PCT));
    // An instance count is integral, so a step must move at least one machine:
    // a small percentage of a small fleet would otherwise round to a permanent
    // no-op and the controller would silently do nothing forever.
    const delta = Math.max(1, Math.round(st.targetInstances * step));

    // The fleet size that would put utilisation exactly on the setpoint, given
    // that (util * currentInstances) instance-equivalents are busy right now.
    // Used to bound a step so the controller cannot overshoot THROUGH its own
    // setpoint: a fixed percentage step alone will happily take a node from
    // 40% utilisation straight into saturation, and then have to scale back
    // up, which is self-inflicted oscillation on top of the real kind.
    //
    // Utilisation is dimensionless -- busy slots over total slots -- so this
    // arithmetic is identical whether the fleet is counted in machines or in
    // threads, which is why moving the controller onto instances changed the
    // unit without changing the control law.
    const busyInstances = util * st.targetInstances;
    const idealInstances = Math.max(
      1,
      Math.ceil(busyInstances / (target > 0 ? target : 1)),
    );

    let want = st.targetInstances;
    if (util > target) {
      // Scale up by a step, but never past what the setpoint actually needs.
      want = Math.min(
        st.targetInstances + delta,
        Math.max(idealInstances, st.targetInstances + 1),
      );
    } else if (util < target - DEAD_BAND) {
      // Scale down by a step, but never below what the setpoint needs. The
      // asymmetry with scale-up is deliberate: shedding too much capacity
      // causes an immediate outage, while adding too much only costs money.
      want = Math.max(st.targetInstances - delta, idealInstances);
    }

    want = want < minInst ? minInst : want > maxInst ? maxInst : want;
    if (want === st.targetInstances) return;

    st.lastDecisionMs = ctx.now;

    if (want < st.targetInstances) {
      // Removing instances is immediate; nothing has to boot. Any pending
      // scale-up is cancelled outright rather than left half-set, so a later
      // read of pendingInstances cannot resurrect a decision this one reversed.
      st.targetInstances = want;
      st.warmupDueMs = -1;
      st.pendingInstances = want;
      ctx.setScale(watched, want);
      return;
    }

    const warmup = Math.max(0, knob(cfg.warmupMs, DEFAULT_WARMUP_MS));
    if (warmup === 0) {
      st.targetInstances = want;
      ctx.setScale(watched, want);
      return;
    }
    // Book the decision. The machines do not exist yet -- this is the lag.
    st.pendingInstances = want;
    st.warmupDueMs = ctx.now + warmup;
  },

  /**
   * Publish everything needed to say, in one sentence, what this controller
   * is doing and why. A student should never have to open the config panel to
   * find out that the box is sitting in a cooldown.
   */
  decorateStats: (ctx, state, stats: NodeStats) => {
    const st = asAutoscaler(state);
    if (!st) return;
    const scaling = st.warmupDueMs >= 0;
    // scaleOf returns null for a kind with no fleet to move. That is not the
    // same as zero instances, and the panel has to be able to tell them apart
    // or it reports a controller that reads the load and mysteriously does
    // nothing.
    const scale = st.watchedId ? ctx.scaleOf(st.watchedId) : 0;
    const live = scale ?? 0;
    // While warming up, report the fleet size being BOOKED rather than the one
    // in force: paired with watchedInstances, the gap between the two numbers
    // is the visible form of the lag this component exists to teach.
    const wanted = scaling ? st.pendingInstances : st.targetInstances;

    stats.watchedId = st.watchedId;
    stats.targetInstances = wanted;
    stats.watchedInstances = live;
    stats.watchedUnscalable = st.watchedId !== '' && scale === null;
    stats.pendingInstances = scaling ? Math.max(0, wanted - live) : 0;
    stats.scaling = scaling;
    stats.watchedUtil = st.watchedId ? (ctx.utilizationOf(st.watchedId) ?? 0) : 0;
    stats.setpoint = clamp01(knob(state.config.targetUtil, DEFAULT_TARGET_UTIL));

    // Which of the three waits it is in, and how much of it is left. Resolved
    // in the same order onTick() applies them, so the label never claims the
    // controller is free to act when the next tick will find it blocked.
    const cooldown = Math.max(0, knob(state.config.cooldownMs, DEFAULT_COOLDOWN_MS));
    if (scaling) {
      stats.scalePhase = 'warming';
      stats.phaseRemainingMs = Math.max(0, st.warmupDueMs - ctx.now);
    } else if (st.observeUntilMs >= 0 && ctx.now < st.observeUntilMs) {
      stats.scalePhase = 'observing';
      stats.phaseRemainingMs = Math.max(0, st.observeUntilMs - ctx.now);
    } else if (ctx.now - st.lastDecisionMs < cooldown) {
      stats.scalePhase = 'cooldown';
      stats.phaseRemainingMs = Math.max(0, cooldown - (ctx.now - st.lastDecisionMs));
    } else {
      stats.scalePhase = 'steady';
      stats.phaseRemainingMs = 0;
    }
  },
};

/* ------------------------------------------------------------------ *
 * region
 * ------------------------------------------------------------------ */

interface RegionState {
  /** Region index currently serving, 0-based. -1 until first use. */
  active: number;
  /**
   * Simulated time an in-progress failover completes, or -1 when traffic is
   * flowing normally. While set, every request to this node is refused.
   */
  failoverDueMs: number;
  /** Region the in-progress failover is moving to. */
  failoverTarget: number;
  /**
   * The value of config.activeRegion the last time this behaviour looked.
   *
   * `config.activeRegion` is the student's INTENT, not the live state: once
   * traffic has failed over, the two legitimately disagree, and the config
   * still names the region that died. Tracking the last-seen value is what
   * separates "the student moved the slider" (follow it) from "the config
   * merely still differs because we failed away from it" (ignore it).
   * Without this the adopt step drags `active` back onto the dead region on
   * the very next request and failover never completes.
   */
  lastConfigured: number;
}

function asRegion(state: NodeStateLike): RegionState | null {
  return (state.ext as RegionState | null) ?? null;
}

/** How many of this node's out edges count as regions. */
function regionCount(state: NodeStateLike): number {
  const declared = state.config.regions;
  // NaN fails every comparison, so `Math.min` and `Math.max` hand it back
  // unchanged. It is then published as the region total, while the census
  // loop that counts healthy regions runs zero times -- and the readout is
  // meant to be derived from the very predicate the routing uses.
  if (!Number.isFinite(declared)) return state.out.length;
  return Math.max(1, Math.min(Math.floor(declared as number), state.out.length));
}

/**
 * The region the student asked for, clamped into the regions that exist.
 *
 * A value that is not a finite number is the first region rather than
 * itself: `Math.floor(NaN)` is NaN, every comparison below is false for it,
 * so it used to be adopted as the live region -- and `out[NaN]` is nothing,
 * which makes the switch route nowhere at all.
 */
function configuredRegion(state: NodeStateLike, count: number): number {
  const raw = state.config.activeRegion;
  if (!Number.isFinite(raw)) return 0;
  const configured = Math.floor(raw as number);
  return configured < 0 ? 0 : configured >= count ? count - 1 : configured;
}

/**
 * Is region `i` usable right now?
 *
 * A region is unreachable either because the node serving it is crashed or
 * because the link to it is partitioned. Both are injected failures, which is
 * what lets a student cause a regional outage without deleting anything.
 */
function regionHealthy(ctx: BehaviourCtx, state: NodeStateLike, i: number): boolean {
  const edge = state.out[i];
  if (!edge) return false;
  if (ctx.isEdgeCut(edge.id)) return false;
  return !ctx.isCrashed(edge.to);
}

/**
 * A multi-region failover switch.
 *
 * Deliberately the simplest construct that teaches the idea: outgoing edge i
 * is region i, exactly one region serves traffic at a time, and when that
 * region becomes unreachable traffic moves to the next healthy one in a fixed
 * scan order.
 *
 * The part worth seeing is that failover is not free. Detection, DNS/anycast
 * convergence and connection re-establishment are collapsed into one
 * `failoverMs` window during which the node serves nothing and every request
 * fails as 'region-down'. A student who sets failoverMs to 30000 to feel safe
 * watches half a minute of total outage; one who sets it to 0 gets a cutover
 * no real system achieves. That trade is the lesson, and collapsing three
 * mechanisms into one number is what keeps it legible.
 *
 * What this deliberately is NOT: a geo-latency model, a replication model, or
 * an active-active router. Those need real links with propagation delay, and
 * SimEdge.latencyMs is where that will go in the networking phase.
 */
const region: ComponentBehaviour = {
  kind: 'region',
  // A switch with no work of its own: it routes and holds nothing.
  blocksOnDownstream: false,
  // A pure switch: it forwards without holding slots of its own.
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  initState: (): RegionState => ({
    active: -1,
    failoverDueMs: -1,
    failoverTarget: -1,
    lastConfigured: -1,
  }),

  onAdmit: () => 'passthru',
  route: () => 'one',
  // pickEdge returning null here is not a wiring mistake: it means no region
  // is serving, either mid-failover or with every region down.
  noRouteReason: 'region-down',

  /**
   * Returning null means "no region is serving", which the engine resolves as
   * a routing failure. The reason is mapped to 'region-down' by the engine's
   * no-route path for this kind, so a student sees WHY it failed rather than a
   * generic routing error.
   */
  pickEdge: (ctx, state, _req, out) => {
    const st = asRegion(state);
    if (!st) return null;

    const cfg = state.config;
    const count = regionCount(state);

    // Adopt the configured region on first use, and follow the student if they
    // CHANGE it in the Inspector. A manual switch is instant and deliberate:
    // a planned migration, not an outage.
    //
    // The trigger is a change in the configured value, never a disagreement
    // between it and the live region -- after a failover the two differ by
    // design, and treating that as a manual switch would drag traffic back
    // onto the region that just died.
    const wanted = configuredRegion(state, count);
    if (st.active === -1 || wanted !== st.lastConfigured) {
      st.lastConfigured = wanted;
      st.active = wanted;
      st.failoverDueMs = -1;
    }

    // A failover in progress lands once its window elapses. Evaluated here,
    // lazily on arrival, rather than from a tick -- so it depends only on
    // simulated time and not on how often the node happened to be polled.
    if (st.failoverDueMs >= 0) {
      if (ctx.now < st.failoverDueMs) return null; // still dark
      st.active = st.failoverTarget;
      st.failoverDueMs = -1;
    }

    if (regionHealthy(ctx, state, st.active)) return out[st.active];

    // The active region is down. Scan forward with wraparound so regions are
    // always tried in the same order; an arbitrary or random pick here would
    // make failover non-reproducible from the same seed.
    let next = -1;
    for (let i = 1; i <= count; i++) {
      const candidate = (st.active + i) % count;
      if (regionHealthy(ctx, state, candidate)) {
        next = candidate;
        break;
      }
    }
    // Every region is down: there is nowhere to fail over to, so the node
    // stays dark rather than pretending a switch would help.
    if (next === -1) return null;

    const failoverMs = Math.max(0, cfg.failoverMs ?? 0);
    if (failoverMs === 0) {
      st.active = next;
      return out[next];
    }

    st.failoverTarget = next;
    st.failoverDueMs = ctx.now + failoverMs;
    return null; // dark for the length of the failover window
  },

  /**
   * Which outgoing edge is live, and which are merely standing by.
   *
   * A standby region is wired, healthy and deliberately unused. Left to the
   * engine's flow-based fallback it would read 'idle' -- indistinguishable
   * from a dead link -- and the entire point of the component (there is a
   * second region sitting there ready) would be invisible on the canvas.
   *
   * Strictly a read: `pickEdge` is where the state machine advances, and
   * duplicating any of that here would let the number of times the UI polled
   * change the simulation.
   */
  edgeStateFor: (ctx, state, _edge, index) => {
    const st = asRegion(state);
    if (!st) return null;
    const count = regionCount(state);
    // Edges past `regions` are not regions at all; the engine's flow-based
    // fallback describes them better than this hook can.
    if (index >= count) return null;

    const live = liveRegionIndex(ctx, state, st);
    // Nothing is serving -- mid-failover, or every region down. No edge is
    // live, and calling the others 'standby' would still be true.
    if (live === -1) return 'standby';
    return index === live ? 'live' : 'standby';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const st = asRegion(state);
    if (!st) return;
    const failingOver = st.failoverDueMs >= 0 && ctx.now < st.failoverDueMs;
    stats.activeRegion = st.active < 0 ? 0 : st.active;
    stats.failingOver = failingOver;
    // How much dark window is left. A pure read of the deadline pickEdge
    // set, so a UI can count the outage down instead of freezing on a flag.
    stats.failoverRemainingMs = failingOver
      ? Math.max(0, st.failoverDueMs - ctx.now)
      : 0;
    // Healthy-region census, from the same predicate pickEdge routes with,
    // so the readout and the routing can never disagree about reachability.
    const count = regionCount(state);
    let healthy = 0;
    for (let i = 0; i < count; i++) {
      if (regionHealthy(ctx, state, i)) healthy += 1;
    }
    stats.regionsHealthy = healthy;
    stats.regionsTotal = count;
    const live = liveRegionIndex(ctx, state, st);
    stats.liveEdgeId = live === -1 ? undefined : state.out[live]?.id;
  },
};

/**
 * The region index traffic would take if a request arrived right now, or -1
 * when none would: mid-failover, or with every region unreachable.
 *
 * A pure mirror of the decision `pickEdge` makes, and it must stay pure --
 * this is called from snapshot(), so advancing `active` or landing a failover
 * from here would make the simulation depend on the UI's polling rate. It
 * therefore reads the failover deadline without clearing it and scans for a
 * healthy region without adopting one; `pickEdge` does the committing when a
 * real request turns up.
 *
 * It intentionally does NOT re-apply the config-adoption step. That step is
 * driven by the student changing the Inspector value, and running it here
 * would consume the change -- pickEdge would then never see it, and a manual
 * region switch would silently do nothing whenever the UI happened to
 * snapshot first.
 */
function liveRegionIndex(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  st: RegionState,
): number {
  const count = regionCount(state);

  // A failover still inside its window: the node is dark, exactly as
  // pickEdge would report by returning null.
  if (st.failoverDueMs >= 0 && ctx.now < st.failoverDueMs) return -1;

  // The window elapsed but no request has arrived to land it yet. The next
  // one will land on failoverTarget, so that is the honest answer now.
  const active = st.failoverDueMs >= 0 ? st.failoverTarget : st.active;
  if (active < 0) {
    // Nothing has been adopted yet; pickEdge would take the configured region.
    const wanted = configuredRegion(state, count);
    return regionHealthy(ctx, state, wanted) ? wanted : -1;
  }

  if (regionHealthy(ctx, state, active)) return active;

  // The active region is down. pickEdge would begin a failover, which is a
  // dark window before the next region takes over -- so report dark, in the
  // same fixed scan order, only conceding a live edge when failoverMs is 0
  // and the cutover really is instant.
  let next = -1;
  for (let i = 1; i <= count; i++) {
    const candidate = (active + i) % count;
    if (regionHealthy(ctx, state, candidate)) {
      next = candidate;
      break;
    }
  }
  if (next === -1) return -1;
  return Math.max(0, state.config.failoverMs ?? 0) === 0 ? next : -1;
}

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const CONTROL_BEHAVIOURS: ComponentBehaviour[] = [autoscaler, region];

/* Re-exported for the verification harness; not used by the engine. */
export type { AutoscalerState, RegionState };
