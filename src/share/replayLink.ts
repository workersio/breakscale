import { buildShareUrl } from '../share';
import type { Engine } from '../sim/engine';
import type { Topology } from '../sim/types';
import { hasStore, ShareStoreError, storeTopology } from './store';

/* ------------------------------------------------------------------ *
 * Design links and replay links.
 *
 * A design link carries the design and nothing about the run. A replay
 * link carries the design, the seed and the fault schedule, which is
 * everything the engine on the far side needs to play the same run from
 * t=0: the same arrivals, and each fault at the simulated moment it
 * happened. Both go through the same store-then-fragment choice.
 *
 * The recipient opens a replay the way they open any shared design: the
 * engine is reset to t=0 and the clock runs. Nothing about the run that
 * was not part of the design or the schedule travels, so a knob turned
 * halfway through the sender's run is replayed as if it had been set
 * from the start.
 * ------------------------------------------------------------------ */

/**
 * The design without its fault schedule, for a plain link. A design with
 * no schedule comes back exactly as given, so its link is the same bytes
 * it was before replay links existed.
 */
export function designTopology(t: Topology): Topology {
  if (t.faults === undefined) return t;
  const { faults: _faults, ...rest } = t;
  return rest;
}

/**
 * The run the engine can replay: its exported design, seed and schedule,
 * with the shell's annotations put back, since the engine never holds them.
 */
export function replayTopology(
  design: Topology,
  engine: Pick<Engine, 'exportTopology'>,
): Topology {
  const run = engine.exportTopology();
  return design.annotations && design.annotations.length > 0
    ? { ...run, annotations: design.annotations }
    : run;
}

/** Whether a design carries a schedule worth a replay link. */
export function hasReplay(t: Topology): boolean {
  return (t.faults?.length ?? 0) > 0;
}

/**
 * Build a link for a topology. The store first, because it keeps the URL
 * short whatever the design; where there is no store, or encoding for it
 * failed for a reason the fragment would not share, the fragment format.
 *
 * Throws `ShareStoreError` when the store was there and said no, and
 * `ShareLinkTooLargeError` when the fragment does not fit.
 */
export async function buildLink(t: Topology, base: string): Promise<string> {
  if (hasStore()) {
    try {
      return await storeTopology(t, base);
    } catch (e) {
      if (e instanceof ShareStoreError) throw e;
      // Anything else came from encoding rather than the network, and
      // the fragment path below would hit it too.
    }
  }
  return buildShareUrl(t, base);
}
