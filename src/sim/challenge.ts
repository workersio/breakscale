import type {
  FaultEvent,
  NodeConfig,
  NodeKind,
  RouteStats,
  SimSnapshot,
  Topology,
} from './types';

/**
 * A brief with a pass condition the engine can check.
 *
 * The sandbox teaches whoever already knows what to try. A brief teaches
 * everyone else, which is most of the people this tool is for: it says what
 * the system has to survive, and lets the reader find out for themselves
 * which part of their design is the one that gives way.
 *
 * A challenge is deliberately NOT a new kind of thing. It is a preset plus a
 * goal, because the expensive half of "add challenges" is authoring
 * scenarios and twenty-three of those already exist. `presetId` says which
 * design to start from; everything else here is the goal.
 */
export interface Challenge {
  id: string;
  /**
   * Bumped whenever a change to the brief could change its verdict: the load,
   * a goal, a fault, the budget or the preset it starts from. A check is
   * keyed to it, so a pass recorded against an older version reads as stale
   * rather than as a pass of something the reader never attempted.
   */
  version: number;
  /** Shown as the heading. A short imperative: "Survive the spike". */
  name: string;
  /**
   * The brief, in the words a client would use rather than in metrics.
   *
   * "Traffic triples at the top of the hour and it has to stay up" is the
   * problem; `goals` below is the same thing stated so a machine can check
   * it. Both are needed: the sentence is what makes it a task rather than a
   * form, and the goals are what make it checkable.
   */
  brief: string;
  presetId: string;
  /**
   * Changes to the preset's nodes, by id, that make it this brief's system:
   * a database a size the preset never had, a standby kept small. Applied by
   * `startDesign`, so the canvas, the locks and the slot budget all start
   * from the same design.
   */
  startOverrides?: Readonly<Record<string, Partial<NodeConfig>>>;
  /**
   * Kinds from `SHORTCUT_KINDS` in judge.ts that this brief lets the reader
   * add one of, because adding one is an answer here rather than a way round
   * the question.
   */
  allowedNewKinds?: readonly NodeKind[];
  /** Offered load the design is judged at, in requests per second. */
  loadRps: number;
  goals: Goal[];
  /**
   * Seconds the check runs before it starts counting, so a queue has had time
   * to form or drain and the verdict is about the design rather than about
   * its first moments. 15 when absent.
   */
  warmupS?: number;
  /** Seconds the check counts for after the warm-up. 45 when absent. */
  windowS?: number;
  /**
   * Faults that are part of the brief, timed from the start of the run. The
   * check replaces whatever faults the reader scheduled with these, because
   * a design is judged against the trouble the brief promised and not
   * against trouble the reader chose.
   */
  faults?: readonly FaultEvent[];
  /**
   * Extra slots the design may add over the one it starts from, or absent for
   * no limit. A slot is one request a component can work on at once; see
   * `slotsOf` in judge.ts for how each kind counts them. 0 means the answer
   * has to come from somewhere other than more room.
   */
  budget?: number;
  /** Difficulty, for grouping in the picker. 1 is the first. */
  tier?: number;
  /**
   * Fields held still on top of `DEFAULT_LOCKS`, for a brief whose lesson
   * would be skipped by changing one of them.
   */
  locks?: readonly FieldLock[];
  /**
   * Nudges, in order, from the smallest one that helps to the one that names
   * the component.
   *
   * Staged rather than a single paragraph because the two people using this
   * need different amounts. Someone practising wants a direction and then to
   * be left alone; someone stuck at minute one needs telling where to look
   * before they close the tab. One hint written for either is wrong for the
   * other, and a hint that gives the answer away in its first sentence turns
   * the brief into a reading exercise.
   *
   * None of them state the fix. The last one narrows to a component and a
   * question, and finding out what to do with it is the exercise.
   */
  hints: string[];
  /**
   * Why the fix worked, shown only once the goals are met.
   *
   * This is the part that makes it teaching rather than a puzzle. Without it
   * a reader passes and takes away "capacity 8 works here", which is worth
   * nothing anywhere else. Withheld until then on purpose: read first, it is
   * the answer, and the brief stops being one.
   */
  lesson: string;
}

/**
 * One checkable condition.
 *
 * Every metric here is measured by the engine already, so a goal never needs
 * the simulation to do anything new. `max` reads as "no more than", which is
 * the direction every one of these happens to run: latency, errors and cost
 * are all things you are trying to keep down.
 */
export interface Goal {
  metric: GoalMetric;
  max: number;
  /**
   * The id of a client, to judge only the requests that client sends rather
   * than all of them, so a brief can say "checkout stays up" while browsing
   * is allowed to suffer. Only for `p99`, `p95` and `errorRate`; the other
   * metrics are about the system's storage and have no route to split by.
   */
  route?: string;
}

/** Whether a goal reads one client's requests rather than everyone's. */
export function isRouteGoal(goal: Goal): goal is Goal & { route: string } {
  return (
    goal.route !== undefined &&
    (goal.metric === 'p99' || goal.metric === 'p95' || goal.metric === 'errorRate')
  );
}

/**
 * `lostWrites` counts writes a write-behind cache said were saved that never
 * reached the store. `lostJobs` counts jobs a queue accepted that then failed
 * once a worker took them. `queueDepth` is the longest line in any queue at
 * the end of the check, in messages. None of them can be read off a single
 * snapshot, so only the check measures them.
 */
export type GoalMetric =
  'p99' | 'errorRate' | 'p95' | 'lostWrites' | 'lostJobs' | 'queueDepth';

/** The metrics a snapshot can be read for, in the live view. */
export function isLiveMetric(metric: GoalMetric): boolean {
  return metric === 'p99' || metric === 'p95' || metric === 'errorRate';
}

/** How one goal came out, with the number that decided it. */
export interface GoalResult {
  goal: Goal;
  actual: number;
  met: boolean;
}

export interface ChallengeResult {
  passed: boolean;
  goals: GoalResult[];
}

/**
 * Read the metric a goal names off a snapshot.
 *
 * errorRate is stored as a fraction and stated in the brief as a percentage,
 * because "under 1%" is how the requirement is written down in real life and
 * "under 0.01" is not.
 */
function actualFor(
  metric: GoalMetric,
  s: Pick<RouteStats, 'p99' | 'p95' | 'errorRate'>,
): number {
  switch (metric) {
    case 'p99':
      return s.p99;
    case 'p95':
      return s.p95;
    case 'errorRate':
      return s.errorRate * 100;
    case 'lostWrites':
    case 'lostJobs':
    case 'queueDepth':
      // Filtered out by isLiveMetric before this is reached.
      return Number.NaN;
  }
}

/**
 * Judge a run.
 *
 * A dead system is a FAILURE, never a pass, and that needs saying because
 * the arithmetic alone would get it wrong. When nothing completes there are
 * no latencies to take a percentile of, so p99 reads 0 and would satisfy any
 * "under 200ms" goal it was given. The errorRate goal catches this on its
 * own in every brief that has one, but a brief judged only on latency would
 * hand out a pass for a total outage. So a run with no goodput fails
 * outright, whatever the other numbers say.
 */
export function evaluate(
  challenge: Challenge,
  snapshot: SimSnapshot,
  routes: readonly RouteStats[] = [],
): ChallengeResult {
  const dead = snapshot.system.goodputRps <= 0;
  const goals = challenge.goals
    .filter((g) => isLiveMetric(g.metric))
    .map((goal) => {
      if (!isRouteGoal(goal)) {
        const actual = actualFor(goal.metric, snapshot.system);
        return { goal, actual, met: !dead && actual <= goal.max };
      }
      // A route with nothing getting through is as dead as a system is, and
      // a client the design no longer has has no reading at all.
      const route = routes.find((r) => r.clientId === goal.route);
      if (route === undefined) return { goal, actual: Number.NaN, met: false };
      const actual = actualFor(goal.metric, route);
      return { goal, actual, met: !dead && route.goodputRps > 0 && actual <= goal.max };
    });
  return { passed: !dead && goals.every((g) => g.met), goals };
}

/**
 * Fields a brief holds still.
 *
 * Not an anti-cheat list. It is the line between a decision you get to make
 * and a fact about the work you have been given, and the simulator already
 * draws it: `derive.ts` refuses to change service time when a larger vendor
 * instance is picked, because a bigger machine does not make a query faster,
 * it runs more of them at once.
 *
 * `serviceMs` is how long the work takes. Setting it to 1ms passes every
 * brief here instantly and teaches nothing, because no engineer gets to
 * declare their database forty times faster by typing a number. `serviceCv`
 * is the same: how uneven the work is, is a property of the work.
 *
 * Everything else stays editable, including the things that look like
 * cheating and are not. Raising capacity to something absurd is a legitimate
 * answer that costs absurd money, which is exactly the tradeoff a budget
 * makes visible later. The brief is not trying to stop anyone, it is trying
 * to keep the question honest.
 */
export const FIXED_DURING_CHALLENGE: readonly string[] = [
  'serviceMs',
  'serviceCv',
  // How often a component fails on its own is a bug in the work, and the
  // read/write mix and how long a write holds its lock are facts about the
  // data. None of them is something a design gets to declare.
  'errorRate',
  'readFraction',
  'lockMs',
];

export function isFixedDuringChallenge(field: string): boolean {
  return FIXED_DURING_CHALLENGE.includes(field);
}

/**
 * One field held still, on every node of one kind or, with `'*'`, on all of
 * them. The check puts it back to the value the brief started with, so
 * changing it can never be what passes.
 */
export interface FieldLock {
  kind: NodeKind | '*';
  field: keyof NodeConfig;
}

/**
 * What every brief holds still: the work, everywhere, and the traffic
 * source. A client stands for the people sending requests, so how long they
 * wait and how often they try again are part of the brief. Its rate is the
 * brief's load, and the check sets that separately.
 */
export const DEFAULT_LOCKS: readonly FieldLock[] = [
  ...FIXED_DURING_CHALLENGE.map((field) => ({
    kind: '*' as const,
    field: field as keyof NodeConfig,
  })),
  { kind: 'client', field: 'rps' },
  { kind: 'client', field: 'timeoutMs' },
  { kind: 'client', field: 'retries' },
  { kind: 'client', field: 'traffic' },
  { kind: 'client', field: 'trafficPeriodS' },
];

/** Every lock a brief holds: the defaults and its own. */
export function locksFor(challenge: Challenge): readonly FieldLock[] {
  return challenge.locks ? [...DEFAULT_LOCKS, ...challenge.locks] : DEFAULT_LOCKS;
}

/** The fields a brief holds still on a node of this kind, for the inspector. */
export function lockedFieldsFor(challenge: Challenge, kind: NodeKind): string[] {
  const out: string[] = [];
  for (const lock of locksFor(challenge)) {
    if ((lock.kind === '*' || lock.kind === kind) && !out.includes(lock.field)) {
      out.push(lock.field);
    }
  }
  return out;
}

/**
 * Split `loadRps` across the clients, in proportion to the rates in `weights`
 * and in whole requests a second that add up to it exactly.
 *
 * Largest remainder: each share is rounded down, and the requests left over
 * go one each to the shares that lost the most to rounding, earliest first
 * on a tie. Rounding each share on its own is what this replaced, and it
 * missed the total: 200 over three clients came to 201. Weights that are all
 * zero, or not numbers, split evenly.
 */
export function splitLoad(loadRps: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const total = Math.max(0, Math.round(loadRps));
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  const exact = clean.map((w) => (sum > 0 ? (total * w) / sum : total / n));
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) shares[order[k].i] += 1;
  return shares;
}

/**
 * The load a challenge is judged at, split across every traffic source in
 * the mix they already have. Changes `topology` in place and returns it.
 */
export function applyLoad(topology: Topology, loadRps: number): Topology {
  const clients = topology.nodes.filter((n) => n.kind === 'client');
  const shares = splitLoad(
    loadRps,
    clients.map((c) => c.config.rps),
  );
  clients.forEach((c, i) => {
    c.config.rps = shares[i];
  });
  return topology;
}
