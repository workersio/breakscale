import type { SimSnapshot, Topology } from '../sim/types';
import type { Verdict } from './bottleneck';

/** One answer, stamped with the simulated time it was read at. */
export interface Finding {
  verdict: Verdict;
  atMs: number;
}

/**
 * The answer still worth showing, or null.
 *
 * Derived on every render rather than cleared by an effect: a deleted or
 * replaced node takes its answer with it, and a clock behind the answer means
 * the run started again. That clock check only covers the moment after a
 * restart, so the app also drops the answer itself whenever it resets the run.
 */
export function currentFinding(
  finding: Finding | null,
  topology: Topology,
  snapshot: SimSnapshot | null,
): Finding | null {
  if (!finding || !snapshot) return null;
  if (snapshot.system.timeMs < finding.atMs) return null;
  const v = finding.verdict;
  if (
    v.kind !== 'idle' &&
    v.nodeId !== null &&
    !topology.nodes.some((n) => n.id === v.nodeId)
  ) {
    return null;
  }
  return finding;
}

/** The node the canvas should ring: only a real problem gets one. */
export function spotlightOf(finding: Finding | null): string | null {
  return finding?.verdict.kind === 'problem' ? finding.verdict.nodeId : null;
}
