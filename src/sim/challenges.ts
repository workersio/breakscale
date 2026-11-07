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
 * failing number is what the preset actually does at that load, and the
 * passing one is what it does after the change named in the hint. They are
 * pinned by tests for the same reason the presets' own copy is, because a
 * brief that has drifted from the simulation is worse than no brief.
 *
 * Deliberately few. Four briefs that each teach a different thing beat
 * twenty that teach the same one, and the set is easier to keep honest.
 */
export const CHALLENGES: Challenge[] = [
  {
    id: 'hold-the-line',
    name: 'Hold the line',
    brief:
      'Your one server and its database are handling 200 requests a second. The team has agreed that 99 out of 100 requests should come back within 200ms, and right now you are well over. Get under it.',
    presetId: 'single-server',
    loadRps: 200,
    goals: [{ metric: 'p99', max: 200 }],
    hints: [
      'Something here is full. Watch the components while it runs and find the one that is busy.',
      'The database is the only thing that queues. Everything else passes work along.',
      'Look at how many requests the database can work on at once, and compare it to how many are arriving.',
    ],
    lesson:
      'A queue forms when work arrives faster than it can be served, and waiting in that queue is most of what a slow request is actually doing. The database was not slow: each request took the same time it always did. There were simply more of them than it had room for, so they waited their turn, and the waiting is what the reader felt as latency.',
  },
  {
    id: 'more-machines',
    name: 'More machines, not bigger ones',
    brief:
      'Three servers share 600 requests a second and they are dropping nearly a third of them. The budget is there for more database capacity. Stop the losses.',
    presetId: 'load-balanced',
    loadRps: 600,
    goals: [{ metric: 'errorRate', max: 1 }],
    hints: [
      'Three servers are sharing the load evenly. What are they all sharing after that?',
      'Try making the database bigger first. Note what happens to the errors.',
      'A bigger machine and more machines are not the same change. One of them helps here.',
    ],
    lesson:
      'Making the database bigger raised how much work one machine could take, and the errors did not move. They were requests turned away because every slot was occupied and the queue behind them was full, which more room per machine does not fix once the arrival rate is past what any single one can absorb. Running more of them does, because the work is shared rather than stacked. This is the difference between scaling up and scaling out, and it is why the second is what people reach for at this point.',
  },
  {
    id: 'stop-the-storm',
    name: 'Stop the storm',
    brief:
      'At 150 requests a second this system is losing every single request. The database is working flat out the whole time, so it is not idle, and it is not broken. Work out where the load is coming from and make it serve traffic again.',
    presetId: 'retry-storm',
    loadRps: 150,
    goals: [
      { metric: 'errorRate', max: 1 },
      { metric: 'p99', max: 250 },
    ],
    hints: [
      'The client is sending 150 a second. Look at what the database is actually being asked for.',
      'The API gives up after 250ms and tries again twice. Work out what that does to the number arriving.',
      'Either fewer attempts reach the database, or the database can take what arrives. Both are real answers, and they cost different things.',
    ],
    lesson:
      'The retries were not responding to the overload, they were causing it. Once queueing pushed the wait past the timeout, every request became three, so the load tripled onto something already full, which made the wait longer and produced more timeouts. That loop is why a retry storm collapses instead of levelling off, and why the database stayed pinned at full utilisation the whole time: the work was real, it was just being done for callers who had already given up.',
  },
  {
    id: 'keep-it-warm',
    name: 'Keep it warm',
    brief:
      'A cache sits in front of this database and traffic has reached 1,200 a second. Requests are timing out and about one in twenty is being lost. The agreement is 99 out of 100 inside 200ms, with losses under one percent.',
    presetId: 'cache-aside',
    loadRps: 1200,
    goals: [
      { metric: 'p99', max: 200 },
      { metric: 'errorRate', max: 1 },
    ],
    hints: [
      'The cache is not the thing that is full. Check what is behind it.',
      'Work out how many of the 1,200 requests a second are getting past the cache.',
      'You can either let fewer through, or make what they land on able to take them. Both work here.',
    ],
    lesson:
      'The database was never sized for the traffic, it was sized for the fraction the cache was leaving it. That is fine until the fraction changes, and it is why a cache is a performance decision with a capacity consequence hiding inside it: the hit rate is quietly part of your database sizing. Both fixes are legitimate and they buy different things. A warmer cache is cheaper and more fragile, since it fails the moment the hit rate drops. More database machines cost more and hold up whatever the cache does.',
  },
];

export function challengeById(id: string): Challenge | undefined {
  return CHALLENGES.find((c) => c.id === id);
}
