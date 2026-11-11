import { describe, expect, it } from 'vitest';
import { decodeTopology } from '../../src/share';
import {
  BREAK_END_MS,
  BREAK_FRAME_MS,
  BREAK_WARMUP_MS,
  measureSeed,
} from '../../src/sim/breakit';
import { Engine } from '../../src/sim/engine';
import { PRESETS } from '../../src/sim/presets';
import type { Topology } from '../../src/sim/types';
import { HOSTED_BREAK, LOCAL_BREAK, breakDesign } from './breakIt';
import type { BreakLimits, BreakRequest } from './breakIt';

const APP = 'https://breakscale.tech/';
const preset = (id: string): Topology => {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p.topology;
};
const UP = { metric: 'errorRate', max: 1 } as const;

async function said(
  design: Topology,
  req: BreakRequest,
  limits: BreakLimits = LOCAL_BREAK,
): Promise<string> {
  const out = await breakDesign(design, req, limits, APP);
  if (!out.ok) throw new Error(out.errors.join('\n'));
  return out.text;
}

describe('break_it', () => {
  it('says what broke it, by how much, against what goal', async () => {
    const text = await said(preset('single-server'), { goal: UP });
    expect(text).toContain('Broke it with one fault');
    expect(text).toContain("Slow Database (id 'db') 5x at 10s for 5s.");
    expect(text).toContain('Between 5s and 35s, 2.2% of requests failed.');
    expect(text).toContain('The goal was 1% or less.');
    expect(text).toContain('No smaller schedule breaks it.');
  });

  it('links to a replay that plays the same run', async () => {
    const out = await breakDesign(
      preset('single-server'),
      { goal: UP },
      LOCAL_BREAK,
      APP,
    );
    if (!out.ok || out.verdict?.status !== 'broken') throw new Error('should break');
    const link = out.text.match(/Replay link[^:]*: (\S+)/)?.[1];
    if (!link) throw new Error('no link');
    const decoded = await decodeTopology(new URL(link).hash);
    if (decoded.status !== 'ok') throw new Error('link did not decode');
    const replay = decoded.topology;
    expect(replay.seed).toBe(out.verdict.measured.seed);

    const e = new Engine(replay, replay.seed);
    while (e.now < BREAK_END_MS - 1e-9) {
      if (Math.abs(e.now - BREAK_WARMUP_MS) < 1e-9) e.startTally();
      e.advance(BREAK_FRAME_MS);
    }
    e.stopTally();
    const tally = e.readTally();
    if (!tally) throw new Error('no tally');
    const run = measureSeed(UP, tally, out.verdict.measured.seed);
    expect(run.failed).toBe(out.verdict.measured.failed);
    expect(run.completed).toBe(out.verdict.measured.completed);
    expect(run.actual).toBe(out.verdict.measured.actual);
  });

  it('says it held and how many schedules it tried', async () => {
    const text = await said(preset('single-server'), {
      goal: { metric: 'p99', max: 5000 },
      kinds: ['slow'],
      maxFaults: 1,
    });
    expect(text).toMatch(
      /^Held\. Tried \d+ fault schedules? over \d+ simulated seconds\./,
    );
    expect(text).toContain('Closest call: slow');
  });

  it('says when the design misses the goal with no faults at all', async () => {
    const text = await said(preset('stripe'), { goal: UP });
    expect(text).toMatch(/^It already misses the goal with no faults, on seed 1\./);
  });

  it('cuts a budget over the cap, and says so', async () => {
    const out = await breakDesign(
      preset('single-server'),
      { goal: UP, budget: 100 },
      { ...HOSTED_BREAK, maxBudget: 5 },
      APP,
    );
    if (!out.ok || out.verdict?.status !== 'broken') throw new Error('should break');
    expect(out.text).toContain('The budget was cut from 100 to 5 schedules');
    expect(out.verdict.tried).toBeLessThanOrEqual(5);
  });

  it('does not call it held when nothing could be tried', async () => {
    const text = await said(
      preset('single-server'),
      { goal: UP, kinds: ['crash'], maxFaults: 1 },
      HOSTED_BREAK,
    );
    expect(text).toMatch(/^Nothing was tried, so this is not a pass/);
    expect(text).not.toContain('Held');
    expect(text).toContain('the search never crashed, failed or cut them whole');
  });

  it('crashes the single points when asked', async () => {
    const text = await said(
      preset('single-server'),
      { goal: UP, kinds: ['crash'], maxFaults: 1, includeSinglePoints: true },
      HOSTED_BREAK,
    );
    expect(text).toContain("Crash API Server (id 'api')");
    expect(text).not.toContain('never crashed');
  });

  it('says when one fault used its share of the budget', async () => {
    const text = await said(
      preset('netflix'),
      { goal: { metric: 'p99', max: 100_000 }, maxFaults: 1, budget: 10 },
      HOSTED_BREAK,
    );
    expect(text).toContain(
      'That used the part of the budget these options allow: 4 of 10 schedules.',
    );
    expect(text).not.toContain('no more schedules');
    expect(text).toContain('No schedule came close.');
    expect(text).not.toContain('yet');
  }, 60_000);

  it('turns away a goal it cannot search, in words', async () => {
    const out = await breakDesign(
      preset('single-server'),
      { goal: { metric: 'queueDepth', max: 1, route: 'nope' }, kinds: ['boom'] },
      LOCAL_BREAK,
      APP,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.join('\n')).toContain('"queueDepth" cannot be searched');
    expect(out.errors.join('\n')).toContain('"nope" is not a client');
    expect(out.errors.join('\n')).toContain('Unknown fault kinds: boom');
  });

  it('gives the same answer every time', async () => {
    const req: BreakRequest = { goal: UP, budget: 20 };
    expect(await said(preset('cache-aside'), req)).toBe(
      await said(preset('cache-aside'), req),
    );
  });

  it('stops on the wall clock without guessing at a verdict', async () => {
    const out = await breakDesign(
      preset('single-server'),
      { goal: UP },
      { ...LOCAL_BREAK, wallMs: -1 },
      APP,
    );
    if (!out.ok) throw new Error('should be accepted');
    expect(out.verdict).toBeNull();
    expect(out.text).toMatch(/^Stopped after \d+ schedules? without an answer/);
  });
});
