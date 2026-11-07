/**
 * Before and after numbers for blocking downstream calls.
 *
 *   bun run tools/blocking-bench.ts
 *
 * One client in front of one service (8 slots, 25ms) in front of one
 * database. At 5s the database is slowed 6x through the fault schedule, and
 * everything below is measured over 15s to 35s, once the run has settled.
 * Run it on this tree and on a checkout from before the change to compare;
 * it only uses API both have, and prints "-" for a field the older engine
 * does not publish.
 *
 * Two databases, because the older engine did not apply a slow fault to a
 * kind that keeps its own slots (the `db` kind among them):
 *
 *   db        the real database kind
 *   leaf      a plain service with the database's numbers, which every
 *             engine slows, so the change in the caller is the blocking alone
 *
 * Two callers:
 *
 *   no timeout   the service waits as long as the database takes
 *   500ms x2     the service gives up after 500ms and retries once
 */

import { Engine } from '../src/sim/engine.ts';
import { defaultConfig } from '../src/sim/presets.ts';
import type {
  NodeConfig,
  NodeKind,
  SimNode,
  SimSnapshot,
  Topology,
} from '../src/sim/types.ts';

const SLOW_AT_MS = 5000;
const FROM_MS = 15000;
const TO_MS = 35000;
const STEP_MS = 100;

function node(id: string, kind: NodeKind, patch: Partial<NodeConfig>): SimNode {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...patch },
  };
}

function topology(
  store: 'db' | 'leaf',
  timeoutMs: number,
  retries: number,
  rps: number,
): Topology {
  const dbConfig: Partial<NodeConfig> = {
    capacity: 6,
    serviceMs: 30,
    serviceCv: 0.7,
    queueLimit: 48,
  };
  return {
    nodes: [
      node('client', 'client', { rps, timeoutMs: 2000 }),
      node('api', 'service', {
        capacity: 8,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 64,
        timeoutMs,
        retries,
      }),
      node('db', store === 'db' ? 'db' : 'service', dbConfig),
    ],
    edges: [
      { id: 'client-api', from: 'client', to: 'api', weight: 1 },
      { id: 'api-db', from: 'api', to: 'db', weight: 1 },
    ],
    faults: [
      {
        atMs: SLOW_AT_MS,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 6 },
      },
    ],
  };
}

interface Row {
  label: string;
  errorPct: number;
  reasons: string;
  p50: number;
  p99: number;
  goodput: number;
  apiBusy: number;
  apiWaiting: number | null;
  apiQueued: number;
  apiUtil: number;
  apiShed: number;
  apiTimeouts: number;
  dbBusy: number;
  dbQueued: number;
  dbShed: number;
}

function measure(label: string, t: Topology): Row {
  const engine = new Engine(t, 7);
  while (engine.now < FROM_MS) engine.advance(STEP_MS);
  const start = engine.snapshot();
  // Errors are measured over the roots that were answered in the window, so a
  // request sent before it and failed inside it cannot push the figure past
  // 100%.
  const okStart = start.nodes.client.totalCompleted;
  const failedStart = start.system.totalFailed;
  const reasonsStart = { ...start.failuresByReason };

  let n = 0;
  const sum = {
    goodput: 0,
    apiBusy: 0,
    apiWaiting: 0,
    apiQueued: 0,
    apiUtil: 0,
    apiShed: 0,
    apiTimeouts: 0,
    dbBusy: 0,
    dbQueued: 0,
    dbShed: 0,
  };
  let sawWaiting = false;
  let last: SimSnapshot = start;
  while (engine.now < TO_MS) {
    engine.advance(STEP_MS);
    last = engine.snapshot();
    const api = last.nodes.api;
    const db = last.nodes.db;
    n++;
    sum.goodput += last.system.goodputRps;
    sum.apiBusy += api.inFlight;
    if (api.waitingOnDownstream !== undefined) {
      sawWaiting = true;
      sum.apiWaiting += api.waitingOnDownstream;
    }
    sum.apiQueued += api.queued;
    sum.apiUtil += api.utilization;
    sum.apiShed += api.shedRate;
    sum.apiTimeouts += api.timeoutRate;
    sum.dbBusy += db.inFlight;
    sum.dbQueued += db.queued;
    sum.dbShed += db.shedRate;
  }

  const failed = last.system.totalFailed - failedStart;
  const total = last.nodes.client.totalCompleted - okStart + failed;
  const reasons: string[] = [];
  for (const [reason, count] of Object.entries(last.failuresByReason)) {
    const delta = count - (reasonsStart[reason as keyof typeof reasonsStart] ?? 0);
    if (delta > 0) reasons.push(`${reason} ${delta}`);
  }
  return {
    label,
    errorPct: total > 0 ? (100 * failed) / total : 0,
    reasons: reasons.length > 0 ? reasons.join(', ') : 'none',
    p50: last.system.p50,
    p99: last.system.p99,
    goodput: sum.goodput / n,
    apiBusy: sum.apiBusy / n,
    apiWaiting: sawWaiting ? sum.apiWaiting / n : null,
    apiQueued: sum.apiQueued / n,
    apiUtil: sum.apiUtil / n,
    apiShed: sum.apiShed / n,
    apiTimeouts: sum.apiTimeouts / n,
    dbBusy: sum.dbBusy / n,
    dbQueued: sum.dbQueued / n,
    dbShed: sum.dbShed / n,
  };
}

function f(v: number, digits = 1): string {
  return v.toFixed(digits);
}

const rows: Row[] = [];
for (const store of ['db', 'leaf'] as const) {
  for (const [timeoutMs, retries] of [
    [0, 0],
    [500, 1],
  ] as const) {
    const caller = timeoutMs > 0 ? `${timeoutMs}ms x${retries + 1}` : 'no timeout';
    rows.push(
      measure(`${store.padEnd(4)} ${caller}`, topology(store, timeoutMs, retries, 50)),
    );
  }
}

console.log(
  `client 50 rps -> api (8 slots, 25ms) -> database (6 slots, 30ms), database slowed 6x at ${SLOW_AT_MS / 1000}s, seed 7`,
);
console.log(
  `means over ${FROM_MS / 1000}s to ${TO_MS / 1000}s, sampled every ${STEP_MS}ms; p50 and p99 are the trailing 5s at the end`,
);
console.log('');
for (const r of rows) {
  console.log(r.label);
  console.log(
    `  system  errors ${f(r.errorPct)}%  goodput ${f(r.goodput)}/s  p50 ${f(r.p50, 0)}ms  p99 ${f(r.p99, 0)}ms  failures: ${r.reasons}`,
  );
  console.log(
    `  api     working ${f(r.apiBusy, 2)}  waiting on db ${r.apiWaiting === null ? '-' : f(r.apiWaiting, 2)}  queued ${f(r.apiQueued)}  utilisation ${f(100 * r.apiUtil)}%  shed ${f(r.apiShed)}/s  timeouts ${f(r.apiTimeouts)}/s`,
  );
  console.log(
    `  db      in service ${f(r.dbBusy, 2)}  queued ${f(r.dbQueued)}  shed ${f(r.dbShed)}/s`,
  );
}
