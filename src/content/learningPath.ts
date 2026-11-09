/* ==========================================================================
   The learning path.

   Every example and every challenge, in an order a student can follow. The
   Examples gallery is a flat grid and the challenges are grouped by
   difficulty; neither says what to open first, or what a challenge builds
   on. Here each track pairs the examples that show an idea with the
   challenges that make the student use it, so a brief arrives after the
   system it is set in.

   Each id appears exactly once across the path. learningPath.test.ts holds
   that against PRESETS and CHALLENGES, so a new example or brief fails the
   suite until it is given a place here.
   ========================================================================== */

export type StepKind = 'example' | 'challenge';

export interface PathStep {
  readonly kind: StepKind;
  /** A preset id for an example, a challenge id for a challenge. */
  readonly id: string;
  /** What the student will learn, in one line. */
  readonly learn: string;
}

export interface PathTrack {
  readonly id: string;
  readonly title: string;
  /** The idea the track is about, in one line. */
  readonly about: string;
  readonly steps: readonly PathStep[];
}

const ex = (id: string, learn: string): PathStep => ({ kind: 'example', id, learn });
const ch = (id: string, learn: string): PathStep => ({ kind: 'challenge', id, learn });

export const LEARNING_PATH: readonly PathTrack[] = [
  {
    id: 'bottlenecks',
    title: 'First bottlenecks',
    about: 'A system is only as fast as the part that fills up first.',
    steps: [
      ex('single-server', 'Find the one part that fills up first.'),
      ex(
        'load-balanced',
        'See why more servers do not help when they share one database.',
      ),
      ch('hold-the-line', 'Find the line requests wait in, and make room there.'),
      ch('nothing-looks-busy', 'Spot a part that is full while it looks half idle.'),
    ],
  },
  {
    id: 'caching',
    title: 'Caching',
    about: 'Answer most requests before they reach the slow part.',
    steps: [
      ex('cache-aside', 'See how the database only feels the reads the cache misses.'),
      ex('cdn-origin', 'See how much traffic an edge cache keeps away from you.'),
      ch('keep-it-warm', "Size a database for the cache's misses, not the whole load."),
      ch(
        'not-everyones-problem',
        'Stop one slow dependency from slowing every request.',
      ),
    ],
  },
  {
    id: 'async',
    title: 'Queues and async',
    about: 'Say "got it" now, and do the work later.',
    steps: [
      ex('async-workers', 'Watch a backlog grow when workers fall behind.'),
      ch(
        'buying-time',
        'Learn why a queue only buys time, and what fixes the shortfall.',
      ),
      ex('event-driven', 'Read consumer lag, fan-out and cold starts on one system.'),
      ex('whatsapp', 'Watch messages wait in line instead of failing.'),
    ],
  },
  {
    id: 'saying-no',
    title: 'Saying no under load',
    about: 'Turning some work away early can serve more people.',
    steps: [
      ex('retry-storm', 'See retries multiply the overload that caused them.'),
      ch('five-seconds', 'Make a system recover once a short slowdown ends.'),
      ex('rate-limited-api', 'See how a limit at the door keeps answers fast.'),
      ch('say-no-fast', 'Serve more people by refusing some of them right away.'),
    ],
  },
  {
    id: 'failures',
    title: 'Surviving failures',
    about: 'Machines and whole regions die. Plan for the day they do.',
    steps: [
      ex(
        'circuit-breaker',
        'Watch a breaker stop calling a dependency that is failing.',
      ),
      ch(
        'lose-a-machine',
        'Spread slots across machines so one crash is not an outage.',
      ),
      ex('multi-region', 'Measure what switching to a standby region really costs.'),
      ch('lose-a-region', 'Size a standby region for the day you need it.'),
      ex('resilient-delivery', 'Choose which work fails, and where failed work goes.'),
      ch('saved-then-lost', 'Find saves that vanish while the error rate stays clean.'),
    ],
  },
  {
    id: 'data',
    title: 'Data at scale',
    about: 'What to do when one database is not enough.',
    steps: [
      ex('read-replicas', 'See how copies add room for reads but not for writes.'),
      ch('checkout-rush', 'Fix a rush of writes that extra copies cannot help.'),
      ex('sharded-database', 'Watch one popular key overload a single shard.'),
      ch('one-hot-key', 'Cool a hot shard while the average looks calm.'),
      ex('specialised-stores', 'See which store fills first when each does one job.'),
    ],
  },
  {
    id: 'real-systems',
    title: 'Real systems',
    about: 'Put it all together, then take apart systems you have heard of.',
    steps: [
      ex('autoscaling-service', 'See why new servers arrive after they were needed.'),
      ex('full-stack', 'Find the first part to break when every tier runs at once.'),
      ch('loud-and-quiet', 'Fix a slow path and a silent backlog at the same time.'),
      ex('discord', 'See connections, not requests, run out first.'),
      ex('uber', 'Watch a stream fall behind without a single error users see.'),
      ex('netflix', 'See why streaming barely touches the cloud, and what does break.'),
      ex('spotify', 'Watch a batch job make the slowest requests rise and fall.'),
      ex('twitter', 'See one celebrity post turn into a flood of writes.'),
      ex('stripe', 'See why a payment system refuses work rather than charge twice.'),
    ],
  },
];
