import type { Challenge } from './challenge';

/**
 * The briefs.
 *
 * Each one is an existing preset with a load and a goal attached, chosen so
 * that the design as it ships FAILS and a specific, findable change makes it
 * pass. A brief you pass without touching anything teaches nothing, and one
 * with no reachable answer teaches less than that.
 *
 * Every threshold here was measured against the engine, not estimated: the
 * failing number is what the start design actually does at that load, and
 * the passing one is what it does after the change the lesson explains.
 * judge.test.ts pins each brief with the answers that pass it, the wrong
 * fixes that must not, and the ways round it that must not either, because a
 * brief that has drifted from the simulation is worse than no brief.
 *
 * Grouped by `tier`, easiest first. Tier 1 is one part that is too small,
 * tier 2 is behaviour under trouble, tier 3 is losing a part and tier 4 is
 * a problem that hides from the obvious reading.
 */
export const CHALLENGES: Challenge[] = [
  /* ---------------- tier 1 ---------------- */
  {
    id: 'hold-the-line',
    version: 2,
    tier: 1,
    name: 'Hold the line',
    brief:
      'Your server and its database get 200 requests a second, and the site feels slow. The team promised that the slowest 1 in 100 requests come back within 200ms. That measure is called p99. They also promised that no more than 1 in 100 requests get lost. Right now the slowest take well over a third of a second. Find what is holding them up.',
    presetId: 'single-server',
    loadRps: 200,
    budget: 6,
    goals: [
      { metric: 'p99', max: 200 },
      { metric: 'errorRate', max: 1 },
    ],
    hints: [
      'Slow usually means waiting. Run it and find where requests stand in line.',
      'The API server is barely working. Most of its slots are waiting for an answer from somewhere else. A slot is one request a part can work on at once.',
      'Look at the database. How many requests can it work on at once? How long does each one take?',
    ],
    lesson:
      'The database was not slow: each query took 30ms, however busy it got. It could work on only 6 at once, about 200 a second, and 200 a second were arriving, so requests waited in line. When a system is slow, find the line first, because the part with the line is the part to fix.',
  },
  {
    id: 'keep-it-warm',
    version: 2,
    tier: 1,
    name: 'Keep it warm',
    brief:
      'A cache sits in front of the database. It answers 85 in 100 reads, so those never reach the database. That share is called the hit rate. Traffic has grown to 1,600 a second. Now requests are slow, and about 7 in 100 get lost. You can add only 2 slots, so the database can only grow a little. Keep the slowest 1 in 100 requests within 200ms, and lose no more than 1 in 100.',
    presetId: 'cache-aside',
    loadRps: 1600,
    budget: 2,
    goals: [
      { metric: 'p99', max: 200 },
      { metric: 'errorRate', max: 1 },
    ],
    hints: [
      'The cache is not the part that is full. Look at what sits behind it.',
      'Work out how many of the 1,600 a second get past the cache. Compare that with what the database can take.',
      "Look at the cache's hit rate. How high does it need to be before what gets past it fits in the database?",
    ],
    lesson:
      'The database only sees the reads the cache misses, so it is sized by the misses, not by the traffic. Going from 85 to 95 hits in 100 cuts the misses from 240 a second to 80, and this database can do about 133. The catch is that the database now depends on the cache: if the cache restarts empty, the full load lands on a database sized for the misses.',
  },
  {
    id: 'nothing-looks-busy',
    version: 1,
    tier: 1,
    name: 'Nothing looks busy',
    brief:
      'At 250 requests a second, the API server keeps turning requests away. Yet it reads under half busy, and the database is about half busy too. Each database query takes 30ms. Keep the slowest 1 in 100 requests within 200ms, and lose no more than 1 in 100.',
    presetId: 'single-server',
    startOverrides: { api: { capacity: 14 }, db: { capacity: 16 } },
    loadRps: 250,
    budget: 16,
    goals: [
      { metric: 'p99', max: 200 },
      { metric: 'errorRate', max: 1 },
    ],
    hints: [
      'Start where requests are being turned away, whatever its busy number says.',
      'Busy only counts the work a part does itself. A slot can be taken while doing no work at all.',
      'Look at the API server. How long does it hold a slot for each request? How many slots does 250 a second need at once?',
    ],
    lesson:
      'The API server held each slot until the database answered, about 55ms, though only 25ms of that was its own work. The slots you need at once are arrivals times how long each is held: 250 a second for 55ms is about 14, every slot it had. Its busy number only counted its own work, so when a part waits on something slower, give it slots for the waiting too.',
  },

  /* ---------------- tier 2 ---------------- */
  {
    id: 'five-seconds',
    version: 1,
    tier: 2,
    name: 'Five seconds',
    brief:
      "This API and its database are fine at 80 requests a second. Ten seconds in, the database has a bad five seconds, and every query takes twice as long. Some requests will fail while it is slow, and that is fine. But last time, the site stayed down long after the database was back to normal. Make sure it comes back. From 25 seconds in, lose no more than 1 in 100 requests, and keep the slowest 1 in 100 within 250ms. You can't add slots.",
    presetId: 'retry-storm',
    loadRps: 80,
    warmupS: 25,
    windowS: 45,
    budget: 0,
    faults: [
      {
        atMs: 10_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 2 },
      },
      { atMs: 15_000, action: 'clear', nodeId: 'db' },
    ],
    goals: [
      { metric: 'errorRate', max: 1 },
      { metric: 'p99', max: 250 },
    ],
    hints: [
      'The database is back to full speed after five seconds. Watch what the rest of the system does after that.',
      'Once things go wrong, compare how many requests a second the client sends with how many the database is asked for.',
      'Look at what the API does when a database call takes too long. What happens to the load on the database when every call comes back late?',
    ],
    lesson:
      'The slowdown started it, and retries kept it going: once queries took longer than the API would wait, each request became three. That kept the database overloaded long after it recovered, which is called a metastable failure, a system that stays broken after its cause is gone. The fix is to stop multiplying the load: retry less, wait longer than a slow answer takes, or turn work away early with a short queue.',
  },
  {
    id: 'not-everyones-problem',
    version: 1,
    tier: 2,
    name: "Not everyone's problem",
    brief:
      "Most pages here come straight from the cache and never touch the database. In this run, the database has a bad ten seconds, and every query takes three times as long. Last time, that slowed the whole site and turned many requests away, cached pages included. Requests that need the database may fail while it is slow, but the rest must not. Lose no more than 2 in 100 overall, and keep the slowest 1 in 100 within 300ms. You can't add slots.",
    presetId: 'cache-aside',
    startOverrides: { api: { capacity: 16 } },
    loadRps: 400,
    budget: 0,
    // With a higher hit rate the misses get too rare to tie up the threads.
    locks: [{ kind: 'cache', field: 'hitRate' }],
    faults: [
      {
        atMs: 20_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 3 },
      },
      { atMs: 30_000, action: 'clear', nodeId: 'db' },
    ],
    goals: [
      { metric: 'errorRate', max: 2 },
      { metric: 'p99', max: 300 },
    ],
    hints: [
      'Most requests never reach the database, yet they fail too. Watch what they are waiting for while it is slow.',
      "Watch the API's slots during the slow ten seconds. What is each one doing?",
      'Look at the path from the cache to the database. How many requests can be waiting down there at once? How many API slots does that tie up?',
    ],
    lesson:
      "An API slot waiting on a slow call can't do anything else, so one slow database spread to every request, even ones that never touched it. Capping how many calls can wait on the database kept the other slots free for cached pages, and the extra calls failed fast instead of piling up. Give each thing you depend on a fixed share of your slots, so when one goes slow, only the requests that need it suffer.",
  },
  {
    id: 'say-no-fast',
    version: 1,
    tier: 2,
    name: 'Say no fast',
    brief:
      "Traffic has grown to 300 requests a second, and almost nobody gets an answer. Users wait two seconds, then give up. There's no money for more servers. Serve as many people as you can, quickly. Keep the slowest 1 in 100 within 200ms, and turn away no more than 3 in 10.",
    presetId: 'rate-limited-api',
    // A limit raised for a launch day, and a queue made deep so that nothing
    // gets dropped.
    startOverrides: {
      limiter: { rateLimitRps: 1000, burst: 1000 },
      api: { queueLimit: 512 },
    },
    loadRps: 300,
    budget: 0,
    goals: [
      // The API finishes about 240 of the 300 a second, so about 20 in 100
      // is the least that can be lost.
      { metric: 'errorRate', max: 30 },
      { metric: 'p99', max: 200 },
    ],
    hints: [
      "Every one of the API's slots is taken the whole time, yet almost nothing succeeds. Follow one request from arriving to being served.",
      "Watch the API's queue, the line of requests waiting for a slot. How long does the last one in line wait? How long will the user wait?",
      'Look at the rate limiter at the front. How many requests a second can the API actually finish? How many does the limiter let in?',
    ],
    lesson:
      "Past its limit, a server only makes people wait longer, and the deep queue let that wait grow until every answer arrived after the user had left. Turning away what it couldn't serve, right away and at the door, kept the line short enough for everyone else to be answered in time. A limit only helps if it sits below what the system can really finish, which is why one set for a bigger day did nothing.",
  },
  {
    id: 'buying-time',
    version: 1,
    tier: 2,
    name: 'Buying time',
    brief:
      'Uploads get a quick "got it" straight away, and the real work happens later in the background. They now arrive at 300 a second. For the first few seconds everything looks fine, then uploads start getting refused. Refuse no more than 1 in 100, and let none of the uploads you accepted fail later. Keep the slowest 1 in 100 answers within 100ms. You have 10 extra slots to spend.',
    presetId: 'async-workers',
    startOverrides: { queue: { queueLimit: 1000 } },
    loadRps: 300,
    budget: 10,
    locks: [
      // A deeper queue only hides the shortfall for longer than the check runs.
      { kind: 'queue', field: 'queueLimit' },
      // A 1ms worker timeout fails every job behind the ack, where no client
      // hears of it, and drains the queue by throwing the work away.
      { kind: 'worker', field: 'timeoutMs' },
    ],
    goals: [
      { metric: 'errorRate', max: 1 },
      { metric: 'p99', max: 100 },
      // An upload that fails behind the ack is lost where no client sees it.
      // Without this, starving the workers' database drains the queue by
      // failing the jobs, and the refusals stop.
      { metric: 'lostJobs', max: 0 },
    ],
    hints: [
      'Nothing fails at the start. Watch which number keeps climbing before the first error.',
      'Compare how fast uploads go into the queue with how fast they come out.',
      'Look at the workers. How many jobs a second can they finish? What is each one waiting on?',
    ],
    lesson:
      "A queue does not fix a shortfall; it only puts it off. Here 100 jobs a second more came in than the workers could finish, so the queue of 1,000 filled in about ten seconds and then started refusing uploads. The queue's size decides how long you can be wrong, but the workers decide whether you are, so watch how deep the queue is, not only the errors.",
  },

  /* ---------------- tier 3 ---------------- */
  {
    id: 'lose-a-machine',
    version: 1,
    tier: 3,
    name: 'Survive a dead machine',
    brief:
      'Your database runs on one big machine, and at 220 requests a second it copes easily. But machines fail. This one will die 25 seconds in and stay down for 20 seconds while it is replaced. Through all of that, lose no more than 1 in 100 requests, and keep the slowest 1 in 100 within 300ms. You can add up to 6 slots.',
    presetId: 'single-server',
    startOverrides: { db: { capacity: 12 } },
    loadRps: 220,
    budget: 6,
    allowedNewKinds: ['cache'],
    // A new cache is allowed, at the hit rate a cache gets by default. At
    // 0.99 it hides the dead machine instead of surviving it.
    locks: [{ kind: 'cache', field: 'hitRate' }],
    faults: [
      { atMs: 25_000, action: 'inject', nodeId: 'db', kind: 'crash-instance' },
      { atMs: 45_000, action: 'clear', nodeId: 'db' },
    ],
    goals: [
      { metric: 'errorRate', max: 1 },
      { metric: 'p99', max: 300 },
    ],
    hints: [
      'Run it and watch the 25 second mark. Which part takes everything down with it?',
      'A bigger copy of the same machine still stops when that machine stops.',
      'Look at the database. If one of its machines died, would the ones left have room for 220 a second?',
    ],
    lesson:
      'One machine is one failure away from zero, however big it is. Spread the same slots across several machines, and losing one costs you a share of your room, as long as the ones left can carry the whole load. This is called N+1 sizing: plan to lose your biggest machine, which is why two halves are not enough.',
  },
  {
    id: 'lose-a-region',
    version: 1,
    tier: 3,
    name: 'Lose a region',
    brief:
      'You serve from the US, with Europe on standby. Europe is kept small to save money. At 25 seconds the US region goes dark and stays dark. The router takes 5 seconds to notice and switch, and nothing gets through while it does, so some loss is expected. Across the minute, lose no more than 10 in 100 requests, and keep the slowest 1 in 100 within 250ms. You can add up to 12 slots.',
    presetId: 'multi-region',
    startOverrides: { 'eu-api': { capacity: 6 }, 'eu-db': { capacity: 2 } },
    loadRps: 250,
    windowS: 60,
    budget: 12,
    locks: [
      // How fast the router notices is the brief's, and so is where it starts.
      { kind: 'region', field: 'failoverMs' },
      { kind: 'region', field: 'activeRegion' },
    ],
    // On the API, not its database: the router only watches the node at the
    // end of each of its own connections.
    faults: [{ atMs: 25_000, action: 'inject', nodeId: 'us-api', kind: 'crash' }],
    goals: [
      // The 5 seconds of switching alone cost about 8 in 100 of a minute.
      { metric: 'errorRate', max: 10 },
      { metric: 'p99', max: 250 },
    ],
    hints: [
      'Watch what Europe does in the seconds after the switch.',
      'Making the US bigger does not help once the US is gone.',
      "Look at Europe's API and Europe's database. Could each of them take all 250 a second on its own?",
    ],
    lesson:
      'A standby region is only as good as the load it can carry on the day you need it. Keep it small to save money, and one outage becomes two: the first region fails, then the standby falls over under traffic it was never sized for. Size the standby for the full load, and remember the switch itself still costs seconds that no amount of room buys back.',
  },
  {
    id: 'checkout-rush',
    version: 1,
    tier: 3,
    name: 'Checkout rush',
    brief:
      "Last month pages were slow, so the team added a fourth read copy of the database, called a replica. Now a sale is on, and 4 in 10 requests are orders, which are writes. At 500 a second, checkout is crawling while the copies sit half idle. Keep the slowest 1 in 100 within 250ms, and lose no more than 1 in 100. You can't add a single slot.",
    presetId: 'read-replicas',
    startOverrides: { replicas: { readFraction: 0.6, replicaCount: 4 } },
    loadRps: 500,
    budget: 0,
    // A cache here would answer orders as if they were reads, which no real
    // cache does. With no slots to spend there is no room for one anyway.
    locks: [{ kind: 'cache', field: 'hitRate' }],
    goals: [
      { metric: 'p99', max: 250 },
      { metric: 'errorRate', max: 1 },
    ],
    hints: [
      'Something here is full and something is idle. Find both.',
      'Select the replica set. The first machine is the primary and the rest are copies. Compare how busy they are.',
      'Look at the replica set. Where does every write go? What is a copy the reads do not need costing you?',
    ],
    lesson:
      'Read copies only ever add room for reads, because every write still lands on the one primary. The fix was to stop paying for a copy the reads did not need and put those slots into bigger machines, which raised what the primary could handle. When writes outgrow one primary, the next step is to split the data across several primaries, called sharding, not to add more copies.',
  },

  /* ---------------- tier 4 ---------------- */
  {
    id: 'one-hot-key',
    version: 1,
    tier: 4,
    name: 'One hot key',
    brief:
      'A celebrity just posted, and half of all reads are now for that one post. The store is split four ways, into parts called shards. The dashboard says it is about half busy, but 1 in 5 requests is failing. Lose no more than 1 in 100, and keep the slowest 1 in 100 within 150ms. You have 8 extra slots.',
    presetId: 'sharded-database',
    startOverrides: { shards: { hotKeyFraction: 0.5 } },
    loadRps: 400,
    budget: 8,
    allowedNewKinds: ['cache'],
    locks: [
      // What people want to read is not a design decision.
      { kind: 'shard', field: 'hotKeyFraction' },
      // Re-sharding is a migration, not a setting.
      { kind: 'shard', field: 'shardCount' },
      { kind: 'cache', field: 'hitRate' },
    ],
    goals: [
      { metric: 'p99', max: 150 },
      { metric: 'errorRate', max: 1 },
    ],
    hints: [
      'The store says it is about half busy. Look at its four parts one at a time, not at the average.',
      "One shard is taking far more than its share. You can't change which post people want to read.",
      'Making every shard bigger costs four slots for each one you add. Look at the line from the API to the store. How much of that traffic does the store actually need to see?',
    ],
    lesson:
      "Sharding splits the data, but it can't split a single key, so every read of that post landed on the same shard. A cache in front of the store answered most of those reads before they reached it, which brought the hot shard under its limit for a few slots. When a store is split, watch each part on its own, because the average can look calm while one part is falling over.",
  },
  {
    id: 'saved-then-lost',
    version: 1,
    tier: 4,
    name: 'Saved, then lost',
    brief:
      'Every save goes into a write-behind cache. It says "saved" in about a millisecond, then writes to the database a moment later. At 20 seconds, the database slows to a quarter of its speed for 10 seconds. Nobody sees an error, but a few hundred saves never reach the database. Lose none of them. Also keep the slowest 1 in 100 answers within 150ms, and lose no more than 1 in 100 requests. There\'s no budget for new machines.',
    presetId: 'resilient-delivery',
    loadRps: 240,
    budget: 0,
    faults: [
      {
        atMs: 20_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 4 },
      },
      { atMs: 30_000, action: 'clear', nodeId: 'db' },
    ],
    goals: [
      { metric: 'p99', max: 150 },
      { metric: 'errorRate', max: 1 },
      { metric: 'lostWrites', max: 0 },
    ],
    hints: [
      'The dashboard is green, so stop watching the client. Follow one save all the way to the database.',
      "During the slowdown, the database can't keep up with the saves sent to it. Look at what it does with the ones it has no room for.",
      'Taking out the write-behind cache makes every save wait on a slow database. Look at the database. Does a save sent later need an answer fast, or does it only need to get there?',
    ],
    lesson:
      'A write-behind cache says "saved" before the data is safe, so anything that goes wrong after that is silent, and the error rate stays clean while data disappears. Nobody was waiting on those writes, so the fix was to let them wait for the database instead of being turned away when its line filled up. Whenever you say yes before the work is done, the work behind it needs its own room to wait and its own alarm.',
  },
  {
    id: 'loud-and-quiet',
    version: 1,
    tier: 4,
    name: 'Loud and quiet',
    brief:
      'Launch night: 1,000 requests a second, and 60 in 100 of the requests that reach the store are about one product. Pages are slow. Behind the scenes, the job queue is thousands deep by the end. Keep the slowest 1 in 100 within 200ms, and lose no more than 1 in 100. Also have 100 jobs or fewer waiting in the queue by the end of the check. You have 6 extra slots.',
    presetId: 'full-stack',
    startOverrides: { shards: { hotKeyFraction: 0.6 } },
    loadRps: 1000,
    budget: 6,
    allowedNewKinds: ['cache'],
    locks: [
      { kind: 'shard', field: 'hotKeyFraction' },
      { kind: 'shard', field: 'shardCount' },
      { kind: 'cache', field: 'hitRate' },
      { kind: 'cdn', field: 'hitRate' },
    ],
    goals: [
      { metric: 'p99', max: 200 },
      { metric: 'errorRate', max: 1 },
      { metric: 'queueDepth', max: 100 },
    ],
    hints: [
      'There are two problems here, and only one of them shows up as slow pages.',
      'One shard of the store is doing most of the work. Separately, count how many jobs reach the queue each second and how many the workers finish.',
      "Six slots won't fix either problem the expensive way. Look at the store and the workers. What is the smallest change that gets each one under the load it actually gets?",
    ],
    lesson:
      "A system can fail loudly and quietly at once: the hot shard made pages slow, while the workers fell a little further behind every second and the queue hid it. Fixing only the loud problem would meet the speed goals and still leave a backlog that never drains. Size each path for the load it really gets, and watch the queue's depth, because users won't report it.",
  },
];

export function challengeById(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}
