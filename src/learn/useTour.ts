import { useCallback, useEffect, useState } from 'react';
import type { SimSnapshot, Topology } from '../sim/types';
import {
  markTourDone,
  nextStage,
  tourSpotlight,
  tourWanted,
  type TourStage,
} from './tourSteps';

export interface TourState {
  /** Showing now. False before a first visit is known, after it ends, and off the first example. */
  open: boolean;
  stage: TourStage;
  /** Skip or finish. Either way it never shows again. */
  end: () => void;
  /** The part to ring on the canvas, or null. */
  spotlight: string | null;
}

/**
 * The first-visit walkthrough's state, held in App because the canvas ring
 * and the card both read it.
 *
 * `applies` is false inside a challenge or once another design is on the
 * canvas; the tour then ends for good, since the student has moved on. So
 * does deleting the part it is about.
 */
export function useTour(
  applies: boolean,
  topology: Topology,
  snapshot: SimSnapshot | null,
  selectedId: string | null,
): TourState {
  const [wanted, setWanted] = useState(tourWanted);
  const [stage, setStage] = useState<TourStage>({ kind: 'load' });
  // A deleted subject, or no client to load it with, leaves nothing to show.
  const fits =
    applies &&
    (stage.kind === 'load'
      ? topology.nodes.some((n) => n.kind === 'client')
      : topology.nodes.some((n) => n.id === stage.nodeId));

  /* Both moves are made while rendering, from the props this render has:
     the stage from what the engine measured, the end from the design having
     moved on. Each returns to rest after one pass, since `nextStage` hands
     back the same stage when nothing changed. */
  if (wanted && !fits) setWanted(false);
  if (wanted && fits && snapshot) {
    const next = nextStage(stage, topology, snapshot, selectedId);
    if (next !== stage) setStage(next);
  }

  const end = useCallback(() => setWanted(false), []);

  // Over, however it ended: never again. Storage is the external system.
  const [shown] = useState(wanted);
  useEffect(() => {
    if (shown && !wanted) markTourDone();
  }, [shown, wanted]);

  const open = wanted && fits;
  return {
    open,
    stage,
    end,
    spotlight: open ? tourSpotlight(stage) : null,
  };
}
