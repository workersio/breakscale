import { describe, expect, it } from 'vitest';
import { playBaseline } from './breakit';
import type { SeedRun } from './breakit';
import { OpLogRecorder, checkReadYourWrites } from './oplog';
import { PRESETS } from './presets';
import type { Topology } from './types';
import { followRequest, verify, verifyErrors } from './verify';

/**
 * The read-your-writes check, on the read replicas example: writes go to
 * the primary and show on the replicas 50ms later, so a client that reads
 * a key it just wrote can be served the old value.
 */

const GOAL = { metric: 'staleReads', max: 0 } as const;

function replicas(lagMs?: number): Topology {
  const p = PRESETS.find((x) => x.id === 'read-replicas');
  if (!p) throw new Error('no read-replicas preset');
  const t = structuredClone(p.topology);
  if (lagMs === undefined) return t;
  return {
    ...t,
    nodes: t.nodes.map((n) =>
      n.kind === 'replica'
        ? { ...n, config: { ...n.config, replicationLagMs: lagMs } }
        : n,
    ),
  };
}

function baseline(t: Topology): SeedRun[] {
  const it = playBaseline(t, GOAL);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value.runs;
  }
}

describe('read your writes', () => {
  it('replication lag serves a client the value from before its own write', () => {
    const runs = baseline(replicas());
    expect(runs.map((r) => r.actual)).toEqual([314, 307, 272]);
    for (const r of runs) expect(r.checked).toBeGreaterThan(7000);
    const v = runs[0].violations?.[0];
    if (v?.check !== 'readYourWrites') throw new Error('expected a stale read');
    // Told the write was saved before the read was sent, and the read was
    // served before the write showed on the replicas.
    expect(v.savedMs).toBeLessThanOrEqual(v.invokedMs);
    expect(v.readMs).toBeLessThan(v.visibleMs);
  });

  it('holds with no lag', () => {
    expect(baseline(replicas(0)).map((r) => r.actual)).toEqual([0, 0, 0]);
  });

  it('only counts a write the client heard was saved before it sent the read', () => {
    const rec = new OpLogRecorder({}, 1);
    rec.invoke(0, 1, 'client', 4);
    rec.invoke(1, 2, 'client', 4);
    rec.invoke(2, 3, 'other', 4);
    // Request 1 writes key 4, visible at 100, and the client hears at 10.
    rec.access(100, 1, 'db', 4, true);
    rec.answer(10, 1, 'client', true, 'error', 'client');
    // Request 3, from another client, reads it at 20: not its own write.
    rec.access(20, 3, 'db', 4, false);
    // Request 2 was sent at 1, before the client heard, and read at 30.
    rec.access(30, 2, 'db', 4, false);
    expect(checkReadYourWrites(rec.read(), 0, 100).count).toBe(0);
    rec.invoke(40, 4, 'client', 4);
    rec.access(50, 4, 'db', 4, false);
    const found = checkReadYourWrites(rec.read(), 0, 100);
    expect(found.count).toBe(1);
    expect(found.violations[0]).toMatchObject({ rid: 4, wroteRid: 1, visibleMs: 100 });
  });
});

describe('verify: staleReads', () => {
  it('is already broken with lag, and the read can be followed', () => {
    const v = verify(replicas(), GOAL);
    if (v.status !== 'alreadyBroken')
      throw new Error(`expected alreadyBroken, got ${v.status}`);
    if (v.first?.check !== 'readYourWrites' || v.replay === undefined) {
      throw new Error('expected a stale read to follow');
    }
    const story = followRequest(v.replay, v.first.rid);
    expect(
      story?.events.some((e) => e.type === 'apply' && e.node === v.first?.nodeId),
    ).toBe(true);
  });

  it('holds with no lag', () => {
    const v = verify(replicas(0), GOAL, { budget: 30 });
    expect(v.status).toBe('held');
  });

  it('explains a design with no lagging store', () => {
    const p = PRESETS.find((x) => x.id === 'single-server');
    if (!p) throw new Error('no single-server preset');
    expect(verifyErrors(p.topology, GOAL)[0]).toMatch(/trail its writes/);
  });
});
