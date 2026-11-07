import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Challenge } from './sim/challenge';
import {
  checkDesign,
  designKey,
  judgedTopology,
  slotBudget,
  startDesign,
} from './sim/judge';
import type { BudgetUse, Unjudgeable, Verdict } from './sim/judge';
import type { Topology } from './sim/types';

/* ------------------------------------------------------------------ *
 * The check, run for the reader.
 *
 * A second after the design stops changing, the check starts on its own.
 * It plays in slices between frames so the live run keeps moving, and it is
 * dropped the moment the design changes again, because a verdict on a
 * design that is no longer on the canvas answers a question nobody asked.
 * "Check again" runs it at once.
 *
 * Verdicts are kept by design key. The check is deterministic, so a design
 * undone back to one already checked has its answer already, and the reader
 * is not made to wait for the same number twice.
 * ------------------------------------------------------------------ */

/** Quiet time after the last change before a check starts, in ms. */
export const CHECK_SETTLE_MS = 1000;
/** Main-thread time one slice of the check may take, in ms. */
export const CHECK_BUDGET_MS = 6;
/** Most often progress reaches React, in ms. The panel re-renders on it. */
const PROGRESS_EVERY_MS = 100;
/** Verdicts remembered. Enough for a few undos; old ones fall off. */
const KEPT_VERDICTS = 16;

/** What the panel's check section shows. */
export type CheckView =
  /** The design changed, or has not been checked yet; a check is coming. */
  | { status: 'stale'; hadVerdict: boolean }
  | { status: 'checking'; run: number; done: number }
  | { status: 'verdict'; verdict: Verdict };

export interface ChallengeCheck {
  /** Key of the design on the canvas, as the check would judge it. */
  key: string;
  /** Slots added over the start design, or null for a brief with no budget. */
  budget: BudgetUse | null;
  /** Why the design cannot be judged, known before any check. */
  unjudgeable: Unjudgeable | null;
  view: CheckView;
  /** Check now, skipping the wait and any remembered verdict. */
  checkAgain: () => void;
}

/**
 * Check `design` against `challenge` whenever it settles. `onVerdict` hears
 * every verdict the moment it lands, for recording a pass.
 */
export function useChallengeCheck(
  challenge: Challenge | undefined,
  design: Topology,
  onVerdict?: (verdict: Verdict, challenge: Challenge) => void,
): ChallengeCheck | null {
  const start = useMemo(() => (challenge ? startDesign(challenge) : null), [challenge]);

  /* Keyed on nodes and edges, not the topology: a note edited or a fault
     recorded makes a new topology object and changes nothing judged. Moving
     a node does make new nodes, and the key comes out the same, which is
     what stops a drag from throwing a verdict away. */
  const { nodes, edges } = design;
  const judged = useMemo(
    () =>
      challenge && start
        ? judgedTopology(challenge, { nodes, edges }, start)
        : { topology: null, unjudgeable: null },
    [challenge, start, nodes, edges],
  );
  const key = useMemo(
    () => (challenge && judged.topology ? designKey(challenge, judged.topology) : ''),
    [challenge, judged.topology],
  );
  const budget = useMemo(
    () =>
      challenge && start && judged.topology
        ? slotBudget(challenge, judged.topology, start)
        : null,
    [challenge, start, judged.topology],
  );

  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, Verdict>>(
    () => new Map(),
  );
  const [progress, setProgress] = useState<{
    key: string;
    run: number;
    done: number;
  } | null>(null);
  /** The most recent verdict, whatever it was for, so stale can say so. */
  const [last, setLast] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const immediateRef = useRef(false);

  /* The design the check reads when it starts, rather than the one it was
     scheduled with: a node dragged during the wait changes nothing judged,
     and restarting the wait for it would make a drag postpone the check. */
  const designRef = useRef(design);
  useLayoutEffect(() => {
    designRef.current = design;
  }, [design]);
  const onVerdictRef = useRef(onVerdict);
  useLayoutEffect(() => {
    onVerdictRef.current = onVerdict;
  }, [onVerdict]);

  const known = verdicts.get(key);

  useEffect(() => {
    if (!challenge || !start || !key || known) return;
    let cancelled = false;
    let timer = 0;
    let lastProgress = -Infinity;
    const immediate = immediateRef.current;
    immediateRef.current = false;

    const begin = () => {
      const it = checkDesign(challenge, designRef.current, { start });
      setProgress({ key, run: 0, done: 0 });
      const pump = () => {
        if (cancelled) return;
        const t0 = performance.now();
        for (;;) {
          const step = it.next();
          if (step.done) {
            const verdict = step.value;
            setVerdicts((m) => {
              const next = new Map(m);
              next.delete(verdict.designKey);
              next.set(verdict.designKey, verdict);
              while (next.size > KEPT_VERDICTS) {
                const oldest = next.keys().next().value;
                if (oldest === undefined) break;
                next.delete(oldest);
              }
              return next;
            });
            setLast(verdict.designKey);
            setProgress(null);
            onVerdictRef.current?.(verdict, challenge);
            return;
          }
          const now = performance.now();
          if (now - t0 >= CHECK_BUDGET_MS) {
            if (now - lastProgress >= PROGRESS_EVERY_MS) {
              lastProgress = now;
              setProgress({ key, run: step.value.run, done: step.value.done });
            }
            timer = window.setTimeout(pump, 0);
            return;
          }
        }
      };
      pump();
    };

    timer = window.setTimeout(begin, immediate ? 0 : CHECK_SETTLE_MS);
    return () => {
      // Abandoned, not finished: the generator is simply never stepped
      // again, and the engine it built goes with it.
      cancelled = true;
      window.clearTimeout(timer);
      // Its progress goes too, or coming back to this design would show it
      // as checking during the wait before the new check starts.
      setProgress((p) => (p?.key === key ? null : p));
    };
  }, [challenge, start, key, known, nonce]);

  const checkAgain = useCallback(() => {
    immediateRef.current = true;
    setVerdicts((m) => {
      if (!m.has(key)) return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
    setNonce((n) => n + 1);
  }, [key]);

  if (!challenge || !judged.topology) return null;

  const view: CheckView = known
    ? { status: 'verdict', verdict: known }
    : progress && progress.key === key
      ? { status: 'checking', run: progress.run, done: progress.done }
      : { status: 'stale', hadVerdict: last?.startsWith(`${challenge.id}@`) ?? false };

  return { key, budget, unjudgeable: judged.unjudgeable, view, checkAgain };
}
