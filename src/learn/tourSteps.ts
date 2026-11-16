import type { SimSnapshot, Topology } from '../sim/types';
import { hasShareHash } from '../share';
import { hasStoredLink } from '../share/store';
import { challengeParam } from '../challengeWorkspace';
import {
  formatCount,
  formatMs,
  formatPct,
  formatRateBare,
  healthOfErr,
  healthOfLatency,
  healthOfLoad,
  type Health,
} from '../components/format';
import {
  FULL,
  MIN_RATE,
  findBottleneck,
  readParts,
  slotsOf,
  type Reading,
} from './bottleneck';

/**
 * The first-visit walkthrough: load it, see what breaks, fix it.
 *
 * Each stage moves on from what the engine measures, never from a timer, so
 * the student cannot be told "the database is full" before it is. The tour
 * runs on the first example only, the one a first visit opens on.
 */

export const TOUR_KEY = 'breakscale.tour.v1';
/** The session key App writes; its presence means this is not a first visit. */
const SESSION_KEY = 'breakscale.session.v1';
/** The load step 1 asks for. Single server runs out near 200 a second. */
export const TOUR_RPS = 300;
/** System error rate a fixed design must be back under. */
const RECOVERED_ERRORS = 0.01;

export type TourStage =
  /** Step 1: raise the load. */
  | { kind: 'load' }
  /** Step 2: a part filled up. `slots` is its total when it did. */
  | { kind: 'broken'; nodeId: string; slots: number }
  /**
   * Step 3: the part is selected, give it more slots. `raisedAtMs` is the sim
   * time the total last went up, so a line still draining is not called a
   * failed fix.
   */
  | {
      kind: 'fix';
      nodeId: string;
      slots: number;
      raisedAtMs?: number;
      raisedTo?: number;
    }
  /** Step 4: it has room again. */
  | { kind: 'fixed'; nodeId: string };

export const STEP_COUNT = 4;

export function stepNumber(stage: TourStage): number {
  switch (stage.kind) {
    case 'load':
      return 1;
    case 'broken':
      return 2;
    case 'fix':
      return 3;
    case 'fixed':
      return 4;
  }
}

/**
 * Should this boot show the tour? Only a first visit: nothing saved, no link
 * to follow, and the tour never finished or skipped before. Read once, before
 * the first render, since the app writes a session straight after.
 */
export function tourWanted(): boolean {
  try {
    if (localStorage.getItem(TOUR_KEY) !== null) return false;
    if (localStorage.getItem(SESSION_KEY) !== null) return false;
    const { search, hash } = window.location;
    if (hasShareHash(hash) || hasStoredLink(search, hash)) return false;
    if (challengeParam(search) !== null) return false;
    return true;
  } catch {
    // Blocked storage would show it on every visit, which is worse than never.
    return false;
  }
}

/** Never show it again. */
export function markTourDone(): void {
  try {
    localStorage.setItem(TOUR_KEY, '1');
  } catch {
    // Storage blocked: tourWanted() already says no without it.
  }
}

/** Total slots: `capacity * instances`, as the inspector edits them. */
export function totalSlots(topology: Topology, nodeId: string): number {
  const n = topology.nodes.find((x) => x.id === nodeId);
  if (!n) return 0;
  return n.config.capacity * Math.max(1, Math.floor(n.config.instances ?? 1));
}

export function readingOf(
  topology: Topology,
  snapshot: SimSnapshot,
  nodeId: string,
): { r: Reading; byId: Map<string, Reading> } | null {
  const readings = readParts(topology, snapshot);
  const byId = new Map(readings.map((x) => [x.node.id, x]));
  const r = byId.get(nodeId);
  return r ? { r, byId } : null;
}

/**
 * Where the tour goes next, from the latest snapshot and selection. Returns
 * the same object when nothing changed, so a caller can skip the update.
 */
export function nextStage(
  stage: TourStage,
  topology: Topology,
  snapshot: SimSnapshot,
  selectedId: string | null,
): TourStage {
  switch (stage.kind) {
    case 'load': {
      const v = findBottleneck(topology, snapshot);
      if (v.kind !== 'problem') return stage;
      // Turning work away starts a moment before the busy share catches up;
      // wait for it, so step 2 can say every slot is taken and be right.
      const at = readingOf(topology, snapshot, v.nodeId);
      if (!at || at.r.fill < FULL) return stage;
      return {
        kind: 'broken',
        nodeId: v.nodeId,
        slots: totalSlots(topology, v.nodeId),
      };
    }
    case 'broken':
      return selectedId === stage.nodeId ? { ...stage, kind: 'fix' } : stage;
    case 'fix': {
      const now = totalSlots(topology, stage.nodeId);
      if (now <= stage.slots) return stage;
      if (now > (stage.raisedTo ?? stage.slots)) {
        return { ...stage, raisedAtMs: snapshot.system.timeMs, raisedTo: now };
      }
      const at = readingOf(topology, snapshot, stage.nodeId);
      if (!at || at.r.struggling) return stage;
      if (!recovered(snapshot)) return stage;
      return { kind: 'fixed', nodeId: stage.nodeId };
    }
    case 'fixed':
      return stage;
  }
}

/**
 * Users would notice it is fixed: almost nothing failing, and p99 back out of
 * the warning band the top bar colours it with. p99 trails the fix by a few
 * seconds while the line drains, which is worth watching, so step 3 waits.
 */
export function recovered(snapshot: SimSnapshot): boolean {
  return (
    snapshot.system.errorRate < RECOVERED_ERRORS &&
    healthOfLatency(p99OrNull(snapshot)) === 'ok'
  );
}

/** The ring on the canvas: on the full part while it is the subject. */
export function tourSpotlight(stage: TourStage): string | null {
  return stage.kind === 'broken' || stage.kind === 'fix' ? stage.nodeId : null;
}

/** One live reading on the tour card: "6/6 slots busy", "399 ms p99". */
export interface TourFigure {
  readonly id: 'slots' | 'waiting' | 'refused' | 'p99' | 'failing';
  /** The number, with a separator but no unit. */
  readonly value: string;
  /** "ms", "/s", "%", or empty. */
  readonly unit: string;
  readonly label: string;
  readonly health: Health;
}

/** "399ms" to "399" and "ms", so the unit can ride smaller than the number. */
function split(text: string): { value: string; unit: string } {
  const m = /^([<\d.,]+)(.*)$/.exec(text);
  return m ? { value: m[1] ?? text, unit: m[2] ?? '' } : { value: text, unit: '' };
}

/**
 * The numbers the tour points at, all from one snapshot: how full the part
 * is, its line, what it turns away, and what users feel (p99 and failures).
 * A reading with nothing behind it is left out, never shown as a guess.
 */
export function tourFigures(
  topology: Topology,
  snapshot: SimSnapshot,
  nodeId: string,
): TourFigure[] {
  const at = readingOf(topology, snapshot, nodeId);
  if (!at) return [];
  const { r } = at;
  const out: TourFigure[] = [];
  const slots = slotsOf(r.node, r.s);
  if (slots !== null) {
    // Calls it is waiting on hold a slot too; the box then reads less busy
    // than full, so those slots are "taken" rather than "busy".
    const held = (r.s.waitingOnDownstream ?? 0) >= 1 && r.s.utilization < FULL;
    out.push({
      id: 'slots',
      value: `${formatCount(Math.min(slots, Math.round(r.fill * slots)))}/${formatCount(slots)}`,
      unit: '',
      label: held ? 'slots taken' : 'slots busy',
      health: healthOfLoad(r.fill),
    });
  } else {
    out.push({
      id: 'slots',
      ...split(formatPct(r.fill)),
      label: 'busy',
      health: healthOfLoad(r.fill),
    });
  }
  out.push({
    id: 'waiting',
    value: formatCount(r.line),
    unit: '',
    label: 'waiting',
    health: 'ok',
  });
  out.push({
    id: 'refused',
    value: formatRateBare(r.refused),
    unit: '/s',
    label: 'turned away',
    health: r.refused >= MIN_RATE ? 'danger' : 'ok',
  });
  const p99 = p99OrNull(snapshot);
  if (p99 !== null) {
    out.push({
      id: 'p99',
      ...split(formatMs(p99)),
      label: 'p99',
      health: healthOfLatency(p99),
    });
  }
  const err = snapshot.system.errorRate;
  out.push({
    id: 'failing',
    ...split(formatPct(err)),
    label: 'failing',
    health: healthOfErr(err),
  });
  return out;
}

function p99OrNull(snapshot: SimSnapshot): number | null {
  const { p99, goodputRps } = snapshot.system;
  return p99 === 0 && goodputRps === 0 ? null : p99;
}
