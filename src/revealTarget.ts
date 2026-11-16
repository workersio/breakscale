import type { Unjudgeable, Verdict } from './sim/judge';
import type { FaultEvent } from './sim/types';

/**
 * Which parts the canvas should keep in view, and a key that changes each
 * time a new panel starts talking about them (see Canvas's `reveal`).
 *
 * In order: the parts the inspector is open on, because the reader just
 * picked them; the parts a "Can you break it?" verdict names, or the whole
 * design while that panel is open on it; the parts a brief's "Cannot check
 * yet" names; the parts an incident breaks.
 */
export interface RevealInput {
  /** Selected node ids while the inspector is showing them, else null. */
  inspecting: readonly string[] | null;
  /** The parts a break hit, by node or edge id, once the search found one. */
  broke: readonly string[] | null;
  /** Every part, while "Can you break it?" is open with no break found. */
  breaking?: readonly string[] | null;
  verdict: Verdict | null;
  /** The faults of an incident playing on the canvas. */
  incident: { id: string; faults: readonly FaultEvent[] } | null;
  /** The charts strip is open, rising over the foot of the canvas. */
  charts?: boolean;
}

export interface Reveal {
  ids: readonly string[];
  key: string;
  /** Zoom out to show them all when a pan cannot. */
  fit?: boolean;
  /**
   * The whole diagram, notes included, rather than `ids`: the charts strip
   * is about everything, and its rise cut the lesson note in half.
   */
  content?: boolean;
}

/** The parts a "Cannot check yet" names, by id. */
export function namedBy(why: Unjudgeable): string[] {
  switch (why.reason) {
    case 'fault-target-missing':
      return [why.target];
    case 'connection-cut':
    case 'connection-added':
      return [why.from, why.to];
    case 'dead-end-added':
      return [why.nodeId];
    default:
      return [];
  }
}

export function revealTarget({
  inspecting,
  broke,
  breaking,
  verdict,
  incident,
  charts = false,
}: RevealInput): Reveal | null {
  if (inspecting && inspecting.length > 0) {
    return { ids: inspecting, key: `inspect:${inspecting.join(',')}` };
  }
  if (broke && broke.length > 0) {
    return { ids: broke, key: `break:${broke.join(',')}` };
  }
  if (breaking && breaking.length > 0)
    return { ids: breaking, key: 'breaking', fit: true };
  if (verdict?.status === 'unjudgeable') {
    const ids = namedBy(verdict.why);
    if (ids.length > 0) {
      return { ids, key: `verdict:${verdict.designKey}:${ids.join(',')}` };
    }
  }
  if (incident) {
    const ids = incident.faults.map((f) => ('nodeId' in f ? f.nodeId : f.edgeId));
    if (ids.length > 0) return { ids, key: `incident:${incident.id}` };
  }
  if (charts) return { ids: [], key: 'charts', content: true };
  return null;
}
