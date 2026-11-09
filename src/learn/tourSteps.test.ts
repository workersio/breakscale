// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { NodeConfig, Topology } from '../sim/types';
import {
  TOUR_KEY,
  TOUR_RPS,
  brokenText,
  fixedText,
  nextStage,
  tourSpotlight,
  tourWanted,
  type TourStage,
} from './tourSteps';

/**
 * The tour against the real engine, seed 1, one snapshot per 100ms of sim
 * time, the way the app feeds it: every step it claims must be measured.
 */
class Run {
  readonly engine: Engine;
  topology: Topology;
  stage: TourStage = { kind: 'load' };
  selected: string | null = null;

  constructor() {
    this.topology = PRESETS[0]!.topology;
    this.engine = new Engine(this.topology, 1);
  }

  set(id: string, patch: Partial<NodeConfig>): void {
    this.engine.updateNodeConfig(id, patch);
    this.topology = {
      ...this.topology,
      nodes: this.topology.nodes.map((n) =>
        n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
      ),
    };
  }

  /** Runs until the stage is `kind`, or `seconds` pass. Returns sim seconds taken. */
  until(kind: TourStage['kind'], seconds: number): number | null {
    for (let i = 1; i <= seconds * 10; i += 1) {
      this.engine.advance(100);
      this.stage = nextStage(
        this.stage,
        this.topology,
        this.engine.snapshot(),
        this.selected,
      );
      if (this.stage.kind === kind) return i / 10;
    }
    return null;
  }
}

describe('the tour on Single server', () => {
  it('waits at the starting load', () => {
    const run = new Run();
    expect(run.until('broken', 30)).toBeNull();
    expect(run.stage).toEqual({ kind: 'load' });
  });

  it('breaks at the load it asks for, naming the database with every slot taken', () => {
    const run = new Run();
    run.until('broken', 3);
    run.set('client', { rps: TOUR_RPS });
    expect(run.until('broken', 5)).not.toBeNull();
    expect(run.stage).toEqual({ kind: 'broken', nodeId: 'db', slots: 6 });
    expect(tourSpotlight(run.stage)).toBe('db');
    const text = brokenText(run.topology, run.engine.snapshot(), 'db');
    expect(text).toMatch(/^Database is full: all 6 slots busy, \d+ waiting in line/);
  });

  it('moves to the fix only once the database is selected', () => {
    const run = new Run();
    run.set('client', { rps: TOUR_RPS });
    run.until('broken', 5);
    expect(run.until('fix', 2)).toBeNull();
    run.selected = 'db';
    expect(run.until('fix', 1)).not.toBeNull();
  });

  it('is fixed by 12 slots once p99 is back, and not by 8', () => {
    const run = new Run();
    run.set('client', { rps: TOUR_RPS });
    run.until('broken', 5);
    run.selected = 'db';
    run.until('fix', 1);
    run.set('db', { capacity: 8 });
    expect(run.until('fixed', 15)).toBeNull();
    expect(run.stage).toMatchObject({ kind: 'fix', raisedTo: 8 });
    run.set('db', { capacity: 12 });
    const took = run.until('fixed', 15);
    expect(took).not.toBeNull();
    const s = run.engine.snapshot();
    expect(s.system.errorRate).toBeLessThan(0.01);
    expect(s.system.p99).toBeLessThan(200);
    expect(tourSpotlight(run.stage)).toBeNull();
    expect(fixedText(run.topology, s, 'db')).toMatch(
      /^Database has room again: \d+% busy with 12 slots\.$/,
    );
  });
});

describe('who sees it', () => {
  afterEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('is a first visit with nothing saved and no link', () => {
    expect(tourWanted()).toBe(true);
  });

  it('is never someone who finished or skipped it', () => {
    localStorage.setItem(TOUR_KEY, '1');
    expect(tourWanted()).toBe(false);
  });

  it('is never a returning visitor', () => {
    localStorage.setItem('breakscale.session.v1', '{}');
    expect(tourWanted()).toBe(false);
  });

  it('is never someone opening a challenge link', () => {
    window.history.replaceState(null, '', '/?challenge=hold-the-line');
    expect(tourWanted()).toBe(false);
  });

  it('is never someone opening a share link', () => {
    window.history.replaceState(null, '', '/#d2.abc');
    expect(tourWanted()).toBe(false);
  });
});
