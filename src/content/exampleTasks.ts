import type {
  Cond,
  ExampleTask,
  Fig,
  NumericField,
  Probe,
  TaskStep,
} from '../learn/exampleTask';

/* ==========================================================================
   The task for each example on the learning path.

   Every step ticks off from what the engine measures. The loads, settings
   and figures below were measured by running each example headless, and
   exampleTasks.content.test.ts runs every task again with the moves it
   asks for: each step has to tick within a set time, and none may tick on
   an untouched run at the example's own load. A claim that stops being
   true fails the suite rather than the student.

   Holds: a step about a state the system must be in waits for it to last
   3 seconds of simulated time. A part near its limit fills for a moment at
   loads where nothing is wrong (CDN and origin's Origin Server reads full
   now and then at its own load), and a tick on that would teach the wrong
   thing.

   No load here is past 5,000 a second, the top of the slider.
   ========================================================================== */

const HOLD = 3000;

/* ---------- probes ---------- */

const LOAD: Probe = { of: 'load' };
const FAILING: Probe = { of: 'failing' };
const P99: Probe = { of: 'p99' };
const busy = (node: string): Probe => ({ of: 'busy', node });
const waiting = (node: string): Probe => ({ of: 'waiting', node });
const turnedAway = (node: string): Probe => ({ of: 'turnedAway', node });
const refused = (node: string): Probe => ({ of: 'refused', node });
const behind = (node: string): Probe => ({ of: 'behind', node });
const expired = (node: string): Probe => ({ of: 'expired', node });
const slots = (node: string): Probe => ({ of: 'slots', node });
const running = (node: string): Probe => ({ of: 'running', node });
const connections = (node: string): Probe => ({ of: 'connections', node });
const served = (node: string): Probe => ({ of: 'served', node });
const shardAverage = (node: string): Probe => ({ of: 'shardAverage', node });
const breakerOpen = (node: string): Probe => ({ of: 'breakerOpen', node });
const setting = (node: string, field: NumericField): Probe => ({
  of: 'setting',
  node,
  field,
});
const crashed = (node: string): Probe => ({ of: 'fault', node, kind: 'crash' });
const slowed = (node: string): Probe => ({ of: 'fault', node, kind: 'slow' });
const glitched = (node: string): Probe => ({ of: 'fault', node, kind: 'errors' });

/* ---------- conditions and figures ---------- */

const atLeast = (probe: Probe, value: number): Cond => ({ probe, atLeast: value });
const below = (probe: Probe, value: number): Cond => ({ probe, below: value });
const on = (probe: Probe): Cond => ({ probe, atLeast: 1 });
const off = (probe: Probe): Cond => ({ probe, below: 1 });
const fig = (probe: Probe, label: string): Fig => ({ probe, label });

const FIG_LOAD = fig(LOAD, 'offered load');
const FIG_FAILING = fig(FAILING, 'failing');
const FIG_P99 = fig(P99, 'p99');

/** "Raise the load to N": ticks as soon as the slider is there. */
const raise = (
  rps: number,
  text = `Raise the load to ${fmt(rps)} requests a second.`,
): TaskStep => ({
  text,
  when: [atLeast(LOAD, rps)],
  action: { kind: 'load', rps },
  figs: [FIG_LOAD],
});

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export const EXAMPLE_TASKS: readonly ExampleTask[] = [
  {
    presetId: 'single-server',
    goal: 'Find the part that fills up first, then give it room.',
    steps: [
      raise(200),
      {
        text: 'Watch Database: every slot fills and requests wait in line.',
        when: [
          atLeast(LOAD, 200),
          atLeast(busy('db'), 0.95),
          atLeast(waiting('db'), 3),
        ],
        holdMs: HOLD,
        ring: 'db',
        figs: [
          fig(busy('db'), 'Database busy'),
          fig(waiting('db'), 'waiting'),
          FIG_P99,
        ],
      },
      {
        text: 'Select Database and raise Slots per instance from 6 to 12.',
        field: 'Slots per instance',
        when: [
          atLeast(LOAD, 200),
          atLeast(slots('db'), 12),
          below(FAILING, 0.01),
          below(waiting('db'), 3),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'db' },
        ring: 'db',
        figs: [fig(slots('db'), 'slots'), fig(busy('db'), 'busy'), FIG_FAILING],
      },
    ],
    learned:
      'Database ran out of slots first, so it set the pace for everything in front of it. Twice the slots cleared the line.',
  },
  {
    presetId: 'load-balanced',
    goal: 'Find out whether more servers help when they share one database.',
    steps: [
      raise(560),
      {
        text: 'Watch Database fill up and turn requests away.',
        when: [
          atLeast(LOAD, 560),
          atLeast(busy('db'), 0.95),
          atLeast(turnedAway('db'), 5),
        ],
        holdMs: HOLD,
        ring: 'db',
        figs: [
          fig(busy('db'), 'Database busy'),
          fig(turnedAway('db'), 'turned away'),
          FIG_FAILING,
        ],
      },
      {
        text: 'Try more servers first: give API 1 a second instance. Requests still fail.',
        field: 'Instances',
        when: [
          atLeast(LOAD, 560),
          atLeast(setting('api1', 'instances'), 2),
          atLeast(FAILING, 0.05),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'api1' },
        ring: 'api1',
        optional: true,
        figs: [fig(setting('api1', 'instances'), 'API 1 instances'), FIG_FAILING],
      },
      {
        text: 'Now select Database and raise Slots per instance from 12 to 24.',
        field: 'Slots per instance',
        when: [atLeast(LOAD, 560), atLeast(slots('db'), 24), below(FAILING, 0.01)],
        holdMs: HOLD,
        action: { kind: 'select', node: 'db' },
        ring: 'db',
        figs: [fig(slots('db'), 'slots'), FIG_FAILING, FIG_P99],
      },
    ],
    learned:
      'With API 1 doubled, a fifth to a third of requests still failed. Twice the database slots took failing to zero. More servers help only when the servers are what is full.',
  },
  {
    presetId: 'cache-aside',
    goal: 'See how the database only feels the reads the cache misses.',
    steps: [
      {
        text: 'Select Cache and lower Hit rate you set from 85% to 30%.',
        field: 'Hit rate you set',
        when: [below(setting('cache', 'hitRate'), 0.35)],
        action: { kind: 'select', node: 'cache' },
        ring: 'cache',
        figs: [
          fig(setting('cache', 'hitRate'), 'hit rate'),
          fig(busy('db'), 'Database busy'),
        ],
      },
      {
        text: 'Watch Database fill up at the same load as before.',
        when: [
          below(setting('cache', 'hitRate'), 0.35),
          atLeast(busy('db'), 0.95),
          atLeast(waiting('db'), 2),
        ],
        holdMs: HOLD,
        ring: 'db',
        figs: [
          fig(busy('db'), 'Database busy'),
          fig(waiting('db'), 'waiting'),
          FIG_P99,
        ],
      },
      {
        text: 'Set the hit rate back to 85% and watch p99 come back down.',
        field: 'Hit rate you set',
        when: [
          atLeast(setting('cache', 'hitRate'), 0.85),
          below(FAILING, 0.01),
          below(P99, 150),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'cache' },
        ring: 'cache',
        figs: [fig(setting('cache', 'hitRate'), 'hit rate'), FIG_P99, FIG_FAILING],
      },
    ],
    learned:
      'At 85% Database saw about 30 requests a second. At 30% it saw about 140, more than its 4 slots could finish, with the same load at the door.',
  },
  {
    presetId: 'cdn-origin',
    goal: 'See how much traffic an edge cache keeps away from your server.',
    steps: [
      {
        text: 'Select CDN Edge and lower Hit rate you set from 90% to 50%.',
        field: 'Hit rate you set',
        when: [below(setting('cdn', 'hitRate'), 0.55)],
        action: { kind: 'select', node: 'cdn' },
        ring: 'cdn',
        figs: [
          fig(setting('cdn', 'hitRate'), 'hit rate'),
          fig(waiting('origin'), 'Origin waiting'),
        ],
      },
      {
        text: 'Watch Origin Server fill up and turn requests away.',
        when: [
          below(setting('cdn', 'hitRate'), 0.55),
          atLeast(turnedAway('origin'), 10),
        ],
        holdMs: HOLD,
        ring: 'origin',
        figs: [
          fig(waiting('origin'), 'Origin waiting'),
          fig(turnedAway('origin'), 'turned away'),
          FIG_P99,
        ],
      },
      {
        text: 'Set the hit rate back to 90%.',
        field: 'Hit rate you set',
        when: [
          atLeast(setting('cdn', 'hitRate'), 0.9),
          below(FAILING, 0.01),
          below(P99, 150),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'cdn' },
        ring: 'cdn',
        figs: [fig(setting('cdn', 'hitRate'), 'hit rate'), FIG_P99, FIG_FAILING],
      },
    ],
    learned:
      'At 90% the origin saw about 40 requests a second. At 50% it saw about 200 and about a fifth failed. The edge was doing most of the work.',
  },
  {
    presetId: 'async-workers',
    goal: 'Watch a backlog grow when the workers fall behind.',
    steps: [
      raise(240),
      {
        text: "Watch Message Queue's line grow while nothing fails.",
        when: [
          atLeast(LOAD, 240),
          atLeast(waiting('queue'), 300),
          below(FAILING, 0.01),
        ],
        ring: 'queue',
        figs: [fig(waiting('queue'), 'waiting'), FIG_FAILING, FIG_P99],
      },
      {
        text: 'Select Workers and raise Slots per instance from 10 to 20. Watch the line drain.',
        field: 'Slots per instance',
        when: [
          atLeast(LOAD, 240),
          atLeast(slots('worker'), 20),
          below(waiting('queue'), 20),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'worker' },
        ring: 'worker',
        figs: [fig(slots('worker'), 'slots'), fig(waiting('queue'), 'waiting')],
      },
    ],
    learned:
      'The queue said yes at once and hid the shortfall in its line, about 45 more jobs every second. Only more workers made it shrink.',
  },
  {
    presetId: 'event-driven',
    goal: 'Find the work that falls behind after the reply has gone.',
    steps: [
      raise(135),
      {
        text: 'Watch Audit Log fill up and turn work away while users barely notice.',
        when: [atLeast(LOAD, 135), atLeast(turnedAway('audit'), 3)],
        holdMs: HOLD,
        ring: 'audit',
        figs: [
          fig(busy('audit'), 'Audit Log busy'),
          fig(turnedAway('audit'), 'turned away'),
          FIG_FAILING,
        ],
      },
      {
        text: 'Select Audit Log and raise Slots per instance from 2 to 4.',
        field: 'Slots per instance',
        when: [
          atLeast(LOAD, 135),
          atLeast(slots('audit'), 4),
          below(turnedAway('audit'), 0.5),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'audit' },
        ring: 'audit',
        figs: [fig(slots('audit'), 'slots'), fig(turnedAway('audit'), 'turned away')],
      },
    ],
    learned:
      'Audit Log turned events away every second while under 2% of requests failed. Work done after the reply can fall behind and nobody is told.',
  },
  {
    presetId: 'whatsapp',
    goal: 'See connections, not requests, run out first.',
    steps: [
      raise(2200),
      {
        text: 'Watch the Offline Store line pass 2,000 messages waiting for their phones.',
        when: [atLeast(LOAD, 2200), atLeast(waiting('offlineq'), 2000)],
        ring: 'offlineq',
        figs: [fig(waiting('offlineq'), 'waiting'), FIG_FAILING],
      },
      {
        text: 'Watch Chat Gateway reach 1,800 of 1,800 connections and turn new phones away.',
        when: [
          atLeast(LOAD, 2200),
          atLeast(connections('wsgw'), 1800),
          atLeast(turnedAway('wsgw'), 10),
        ],
        holdMs: 2000,
        ring: 'wsgw',
        figs: [
          fig(connections('wsgw'), 'connections'),
          fig(turnedAway('wsgw'), 'turned away'),
          FIG_FAILING,
        ],
      },
    ],
    learned:
      'Messages for offline phones waited in line instead of failing. What ran out was connections: the gateway holds 1,800 open at once.',
  },
  {
    presetId: 'retry-storm',
    goal: 'See retries keep an overload going after its cause is gone.',
    steps: [
      raise(135),
      {
        text: 'Watch failing climb to 100%.',
        when: [atLeast(FAILING, 0.95)],
        holdMs: 2000,
        ring: 'db',
        figs: [FIG_FAILING, fig(turnedAway('db'), 'Database turned away')],
      },
      {
        text: 'Bring the load back to 45. It keeps failing.',
        when: [below(LOAD, 46), atLeast(FAILING, 0.95)],
        holdMs: 5000,
        action: { kind: 'load', rps: 45 },
        figs: [FIG_LOAD, FIG_FAILING],
      },
      {
        text: 'Select API Server and set Retries to 0.',
        field: 'Retries',
        when: [
          below(LOAD, 46),
          below(setting('api', 'retries'), 1),
          below(FAILING, 0.01),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'api' },
        ring: 'api',
        figs: [fig(setting('api', 'retries'), 'retries'), FIG_FAILING],
      },
    ],
    learned:
      'Back at its normal load it still failed every request, because each failure sent two more. With retries off it recovered within about a second.',
  },
  {
    presetId: 'rate-limited-api',
    goal: 'See how a limit at the door keeps answers fast.',
    steps: [
      raise(600),
      {
        text: 'Watch Rate Limiter let about 200 a second in and refuse the rest at once.',
        when: [atLeast(LOAD, 600), atLeast(refused('limiter'), 100), below(P99, 200)],
        holdMs: HOLD,
        ring: 'limiter',
        figs: [fig(refused('limiter'), 'refused'), FIG_P99],
      },
    ],
    learned:
      'About two in three requests were refused at the door, and the ones let in stayed quick: p99 about 80ms instead of a long line at API Server.',
  },
  {
    presetId: 'circuit-breaker',
    goal: 'Watch a breaker stop calling a dependency that is failing.',
    steps: [
      {
        text: 'Select Payments API and press Crash.',
        when: [on(crashed('payments'))],
        action: { kind: 'select', node: 'payments' },
        ring: 'payments',
        figs: [fig(breakerOpen('breaker'), 'breaker')],
      },
      {
        text: 'Watch Circuit Breaker open and refuse calls at once.',
        when: [on(breakerOpen('breaker')), atLeast(refused('breaker'), 10)],
        ring: 'breaker',
        figs: [
          fig(breakerOpen('breaker'), 'breaker'),
          fig(refused('breaker'), 'refused'),
        ],
      },
      {
        text: 'Press Fix on Payments API and watch the breaker close.',
        when: [
          off(crashed('payments')),
          off(breakerOpen('breaker')),
          below(FAILING, 0.01),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'payments' },
        ring: 'breaker',
        figs: [fig(breakerOpen('breaker'), 'breaker'), FIG_FAILING],
      },
    ],
    learned:
      'About a second after the crash the breaker opened and stopped sending calls to a service that could not answer. It tried again on its own and closed about 2 seconds after the fix.',
  },
  {
    presetId: 'multi-region',
    goal: 'Measure what switching to a standby region really costs.',
    steps: [
      {
        text: 'Select US API and press Crash.',
        when: [on(crashed('us-api'))],
        action: { kind: 'select', node: 'us-api' },
        ring: 'us-api',
        figs: [FIG_FAILING],
      },
      {
        text: 'Watch every request fail while Region Router notices.',
        when: [on(crashed('us-api')), atLeast(FAILING, 0.5)],
        ring: 'router',
        figs: [FIG_FAILING, fig(served('eu-api'), 'EU API served')],
      },
      {
        text: 'Watch EU API take over.',
        when: [
          on(crashed('us-api')),
          atLeast(served('eu-api'), 100),
          below(FAILING, 0.01),
        ],
        holdMs: HOLD,
        ring: 'eu-api',
        figs: [fig(served('eu-api'), 'EU API served'), FIG_FAILING],
      },
    ],
    learned:
      'For about 5 seconds every request failed, then EU API served all of them. A standby region saves the day, but not the first few seconds.',
  },
  {
    presetId: 'resilient-delivery',
    goal: 'Keep one slow service from tying up everything else.',
    steps: [
      {
        text: 'Select Recommendations and press Slow.',
        when: [on(slowed('recs'))],
        action: { kind: 'select', node: 'recs' },
        ring: 'recs',
        figs: [fig(busy('recs'), 'Recommendations busy')],
      },
      {
        text: 'Watch Recs Bulkhead hold 12 calls at once and refuse the rest.',
        when: [on(slowed('recs')), atLeast(refused('bulkhead'), 50)],
        holdMs: HOLD,
        ring: 'bulkhead',
        figs: [
          fig(refused('bulkhead'), 'refused'),
          fig(served('db'), 'Database writes'),
        ],
      },
    ],
    learned:
      'Calls to Recommendations were refused fast instead of waiting, so writes kept reaching Database at about 240 a second. Failing still read about 65%, because every refused call counts.',
  },
  {
    presetId: 'read-replicas',
    goal: 'See how copies add room for reads but not for writes.',
    steps: [
      raise(900),
      {
        text: 'Watch Replica Set fill up and turn requests away.',
        when: [atLeast(LOAD, 900), atLeast(turnedAway('replicas'), 10)],
        holdMs: HOLD,
        ring: 'replicas',
        figs: [
          fig(busy('replicas'), 'Replica Set busy'),
          fig(turnedAway('replicas'), 'turned away'),
          FIG_FAILING,
        ],
      },
      {
        text: 'Select Replica Set and raise Read replicas from 3 to 5.',
        field: 'Read replicas',
        when: [
          atLeast(LOAD, 900),
          atLeast(setting('replicas', 'replicaCount'), 5),
          below(FAILING, 0.01),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'replicas' },
        ring: 'replicas',
        figs: [
          fig(setting('replicas', 'replicaCount'), 'read replicas'),
          FIG_FAILING,
          FIG_P99,
        ],
      },
      {
        text: 'Now lower Reads, as a share of traffic, from 85% to 30%.',
        field: 'Reads, as a share of traffic',
        when: [
          atLeast(LOAD, 900),
          below(setting('replicas', 'readFraction'), 0.35),
          atLeast(turnedAway('replicas'), 10),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'replicas' },
        ring: 'replicas',
        figs: [
          fig(setting('replicas', 'readFraction'), 'reads'),
          fig(turnedAway('replicas'), 'turned away'),
          FIG_FAILING,
        ],
      },
    ],
    learned:
      'Two more copies took failing from about 20% to 0. With mostly writes, about half failed again: every write goes to the one primary, and copies cannot share it.',
  },
  {
    presetId: 'sharded-database',
    goal: 'Watch one popular key overload a single shard.',
    steps: [
      {
        text: 'Select Sharded Store and raise Traffic hitting one hot key from even to 80%.',
        field: 'Traffic hitting one hot key',
        when: [atLeast(setting('shards', 'hotKeyFraction'), 0.75)],
        action: { kind: 'select', node: 'shards' },
        ring: 'shards',
        figs: [
          fig(busy('shards'), 'busiest shard'),
          fig(shardAverage('shards'), 'average'),
        ],
      },
      {
        text: 'Watch the busiest shard fill up while the average stays near a third.',
        when: [
          atLeast(setting('shards', 'hotKeyFraction'), 0.75),
          atLeast(busy('shards'), 0.95),
          below(shardAverage('shards'), 0.6),
        ],
        holdMs: HOLD,
        ring: 'shards',
        figs: [
          fig(busy('shards'), 'busiest shard'),
          fig(shardAverage('shards'), 'average'),
          FIG_FAILING,
        ],
      },
      {
        text: 'Set Traffic hitting one hot key back to even.',
        field: 'Traffic hitting one hot key',
        when: [below(setting('shards', 'hotKeyFraction'), 0.05), below(FAILING, 0.01)],
        holdMs: HOLD,
        action: { kind: 'select', node: 'shards' },
        ring: 'shards',
        figs: [fig(busy('shards'), 'busiest shard'), FIG_FAILING],
      },
    ],
    learned:
      'One shard was full and over 40% failed while the average shard read about 35% busy. An average can hide the one part that is on fire.',
  },
  {
    presetId: 'specialised-stores',
    goal: 'See which store fills first when each does one job.',
    steps: [
      raise(990),
      {
        text: 'Watch Vector Index fill up and turn searches away.',
        when: [atLeast(LOAD, 990), atLeast(turnedAway('vectors'), 10)],
        holdMs: HOLD,
        ring: 'vectors',
        figs: [
          fig(busy('vectors'), 'Vector Index busy'),
          fig(turnedAway('vectors'), 'turned away'),
          FIG_FAILING,
        ],
      },
      {
        text: 'Now look at Cold Storage: nearly every slot busy, and hardly a request depends on it.',
        when: [atLeast(LOAD, 990), atLeast(busy('glacier'), 0.9)],
        holdMs: HOLD,
        ring: 'glacier',
        figs: [fig(busy('glacier'), 'Cold Storage busy'), FIG_FAILING],
      },
    ],
    learned:
      'Vector Index ran out first, with about 10% failing. Cold Storage was almost full too, but only the batch jobs wait on it, so users never felt it.',
  },
  {
    presetId: 'checkout',
    goal: 'See a checkout look healthy on every chart while it can charge twice.',
    steps: [
      raise(300, 'Raise the load to 300 requests a second, three times its own.'),
      {
        text: 'Watch Payments run nearly full while failing stays at 0%.',
        when: [atLeast(busy('pay'), 0.9), below(FAILING, 0.001)],
        holdMs: HOLD,
        ring: 'pay',
        figs: [fig(busy('pay'), 'busy'), FIG_FAILING],
      },
      {
        text: "Set Checkout API's Retries to 0, so a slow charge is never sent again.",
        when: [below(setting('api', 'retries'), 1)],
        action: { kind: 'select', node: 'api' },
        ring: 'api',
        field: 'Retries',
        figs: [fig(setting('api', 'retries'), 'retries')],
      },
    ],
    learned:
      'Payments ran over 90% full and the failing figure never left 0%. No chart can say whether a slow charge was tried twice; Can you break it? checks every call for that.',
  },
  {
    presetId: 'autoscaling-service',
    goal: 'See why new servers arrive after they were needed.',
    steps: [
      raise(500),
      {
        text: 'Watch requests fail while Autoscaler decides.',
        when: [atLeast(LOAD, 500), atLeast(FAILING, 0.1)],
        holdMs: 2000,
        ring: 'api',
        figs: [fig(running('api'), 'API instances'), FIG_FAILING],
      },
      {
        text: 'Watch new instances arrive and failing drop back to zero.',
        when: [atLeast(LOAD, 500), atLeast(running('api'), 5), below(FAILING, 0.01)],
        holdMs: HOLD,
        ring: 'api',
        figs: [fig(running('api'), 'API instances'), FIG_FAILING, FIG_P99],
      },
    ],
    learned:
      'For about 9 seconds up to 30% failed before the new instances were ready. An autoscaler reacts to load it has already seen.',
  },
  {
    presetId: 'full-stack',
    goal: 'Find the first part to give way when every tier runs at once.',
    steps: [
      raise(2400),
      {
        text: "Watch Job Queue's line pass 2,000 while nothing fails.",
        when: [
          atLeast(LOAD, 2400),
          atLeast(waiting('queue'), 2000),
          below(FAILING, 0.01),
        ],
        ring: 'queue',
        figs: [fig(waiting('queue'), 'waiting'), FIG_FAILING],
      },
      {
        text: 'Keep watching: the line reaches 5,000 and the queue turns jobs away.',
        when: [atLeast(LOAD, 2400), atLeast(turnedAway('queue'), 50)],
        holdMs: 2000,
        ring: 'queue',
        figs: [
          fig(waiting('queue'), 'waiting'),
          fig(turnedAway('queue'), 'turned away'),
          FIG_FAILING,
        ],
      },
    ],
    learned:
      'Workers fell behind first. The queue hid it for about 10 seconds, then about 20% failed once its line of 5,000 was full.',
  },
  {
    presetId: 'discord',
    goal: 'See connections, not requests, run out first.',
    steps: [
      raise(1000),
      {
        text: 'Watch Gateway (WS) fill all 1,600 connections and turn new ones away.',
        when: [
          atLeast(LOAD, 1000),
          atLeast(connections('gateway'), 1600),
          atLeast(turnedAway('gateway'), 10),
        ],
        holdMs: HOLD,
        ring: 'gateway',
        figs: [
          fig(connections('gateway'), 'connections'),
          fig(turnedAway('gateway'), 'turned away'),
          FIG_FAILING,
        ],
      },
    ],
    learned:
      'Each user holds a connection open the whole time, so the gateway filled up about 13 seconds after the load went up, then turned away about 100 to 130 a second.',
  },
  {
    presetId: 'uber',
    goal: 'Watch a stream fall behind without an error users see.',
    steps: [
      raise(1720),
      {
        text: 'Watch Kafka Event Bus fall over 2,000 events behind while under 1% fails.',
        when: [
          atLeast(LOAD, 1720),
          atLeast(behind('kafka'), 2000),
          below(FAILING, 0.01),
        ],
        ring: 'kafka',
        figs: [fig(behind('kafka'), 'events behind'), FIG_FAILING],
      },
      {
        text: 'Select Payments and press Crash. Watch Payment Breaker open.',
        when: [
          on(crashed('payments')),
          on(breakerOpen('pay-brk')),
          below(FAILING, 0.05),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'payments' },
        ring: 'pay-brk',
        figs: [fig(breakerOpen('pay-brk'), 'breaker'), FIG_FAILING],
      },
    ],
    learned:
      'The stream fell thousands of events behind and users saw no errors. With Payments down, the breaker kept failing to about 2%.',
  },
  {
    presetId: 'netflix',
    goal: 'Find what breaks when everyone presses play at once.',
    steps: [
      raise(5000),
      {
        text: 'Watch DRM License Svc fill up and turn requests away.',
        when: [atLeast(LOAD, 5000), atLeast(turnedAway('license'), 10)],
        holdMs: HOLD,
        ring: 'license',
        figs: [
          fig(busy('license'), 'DRM busy'),
          fig(turnedAway('license'), 'turned away'),
          FIG_FAILING,
        ],
      },
      {
        text: 'Select DRM License Svc and raise Slots per instance from 5 to 10.',
        field: 'Slots per instance',
        when: [
          atLeast(LOAD, 5000),
          atLeast(slots('license'), 10),
          below(turnedAway('license'), 0.5),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'license' },
        ring: 'license',
        figs: [
          fig(slots('license'), 'slots'),
          fig(turnedAway('license'), 'turned away'),
          FIG_FAILING,
        ],
      },
    ],
    learned:
      'The video itself came from the edge caches. The small licence check every play needs was the first thing to fill.',
  },
  {
    presetId: 'spotify',
    goal: 'Watch a stream fall behind until it starts dropping events.',
    steps: [
      raise(5000, 'Raise the load to 5,000 requests a second, the top of the slider.'),
      {
        text: 'Watch Event Delivery fall over 2,000 events behind while p99 stays steady.',
        when: [atLeast(LOAD, 5000), atLeast(behind('kafka'), 2000)],
        ring: 'kafka',
        figs: [fig(behind('kafka'), 'events behind'), FIG_P99],
      },
      {
        text: 'Keep watching: once the stream is full, the oldest events expire.',
        when: [atLeast(LOAD, 5000), atLeast(expired('kafka'), 5)],
        holdMs: 2000,
        ring: 'kafka',
        figs: [
          fig(behind('kafka'), 'events behind'),
          fig(expired('kafka'), 'expired'),
          FIG_FAILING,
        ],
      },
    ],
    learned:
      'Listeners never noticed: p99 stayed about 140ms. The cost was in the stream, which filled up in about 24 seconds and began throwing away the oldest events.',
  },
  {
    presetId: 'twitter',
    goal: 'See one busy minute of posts turn into a backlog of writes.',
    steps: [
      raise(660),
      {
        text: 'Watch Tweet Firehose fall over 250 posts behind. It can take 30 seconds.',
        when: [atLeast(LOAD, 660), atLeast(behind('firehose'), 250)],
        holdMs: 2000,
        ring: 'firehose',
        figs: [fig(behind('firehose'), 'posts behind'), FIG_P99],
      },
    ],
    learned:
      'Every post is copied into every follower timeline, so the fan-out workers fell behind while readers saw p99 stay about 85 to 120ms.',
  },
  {
    presetId: 'stripe',
    goal: 'See why a payment system refuses work rather than get it wrong.',
    steps: [
      {
        text: 'Select Card Networks (external) and press Glitch.',
        when: [on(glitched('cardnet'))],
        action: { kind: 'select', node: 'cardnet' },
        ring: 'cardnet',
        figs: [fig(breakerOpen('breaker'), 'breaker'), FIG_FAILING],
      },
      {
        text: 'Watch Network Breaker open and stop calling it.',
        when: [on(breakerOpen('breaker'))],
        holdMs: 1000,
        ring: 'breaker',
        figs: [fig(breakerOpen('breaker'), 'breaker'), FIG_P99],
      },
      {
        text: 'Select the Ledger and press Crash. Payments stop, reports carry on.',
        when: [
          on(crashed('ledger')),
          below(served('paysvc'), 1),
          atLeast(served('reportsvc'), 50),
        ],
        holdMs: HOLD,
        action: { kind: 'select', node: 'ledger' },
        ring: 'ledger',
        figs: [fig(served('paysvc'), 'payments'), fig(served('reportsvc'), 'reports')],
      },
    ],
    learned:
      'With the ledger down, Payment Service finished no payments at all, while Reporting API kept answering about 100 to 140 a second from the replicas.',
  },
];

const BY_ID: ReadonlyMap<string, ExampleTask> = new Map(
  EXAMPLE_TASKS.map((t) => [t.presetId, t]),
);

export function taskFor(presetId: string | null): ExampleTask | undefined {
  return presetId === null ? undefined : BY_ID.get(presetId);
}
