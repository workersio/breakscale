import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pumpJob } from './breakitJob';
import type { BreakJob, BreakJobResult, FromWorker, ToWorker } from './breakitJob';
import {
  DEFAULT_OPTIONS,
  HARDER_BUDGET,
  MAX_REMEMBERED,
  breakGoals,
  breakKey,
  defaultMax,
  scheduleKey,
  searchDesign,
  singlePointsFor,
} from './sim/breakit';
import type {
  Attack,
  Baseline,
  BreakOptions,
  GoalTemplate,
  SearchProgress,
  SearchResult,
  SinglePoint,
} from './sim/breakit';
import type { Goal } from './sim/challenge';
import type { Topology } from './sim/types';
import { CHECK_BUDGET_MS } from './useChallengeCheck';

/* ------------------------------------------------------------------ *
 * "Can you break it?", run for the reader.
 *
 * The search runs in a worker so the canvas keeps its frames; where there is
 * no worker, or the page's policy refuses one, the same generator runs on
 * the main thread in short slices. Either way the answer is the same, since
 * nothing in it reads the clock.
 *
 * Answers are kept by key: the design as the engine runs it, the goal, the
 * options and the remembered breaks. Running the same thing again shows the
 * answer it already has.
 * ------------------------------------------------------------------ */

/** Quiet time after a change before the fault-free figures are measured again. */
const BASELINE_SETTLE_MS = 400;
/** Answers kept. */
const KEPT_RESULTS = 16;

export type BreakView =
  | { status: 'picking' }
  | { status: 'searching'; progress: SearchProgress | null }
  /** Stopped by the reader; Keep going carries on from here. */
  | { status: 'stopped'; progress: SearchProgress | null }
  | {
      status: 'done';
      result: SearchResult;
      /** The design and goal it is about, for the replay. */
      design: Topology;
      goal: Goal;
      /** The design's own key when it ran, for saying it is out of date. */
      designSig: string;
    };

export interface BreakSearch {
  templates: GoalTemplate[];
  /** Fault-free figures per template, once measured for this design. */
  baselines: Baseline[] | null;
  goalId: string;
  setGoalId: (id: string) => void;
  /** The selected goal with its number. */
  goal: Goal;
  /** Each template's number, edited or default. */
  maxOf: (id: string) => number;
  setMax: (id: string, max: number) => void;
  opts: BreakOptions;
  setOpts: (opts: BreakOptions) => void;
  singlePoints: SinglePoint[];
  view: BreakView;
  /** The design changed after the answer on screen. */
  stale: boolean;
  /** The selected goal's client was deleted. */
  goalGone: boolean;
  remembered: Attack[][];
  start: (harder?: boolean) => void;
  stop: () => void;
  keepGoing: () => void;
  backToGoals: () => void;
  /** Keep a break to try first next time. */
  remember: (attacks: Attack[]) => void;
}

/** One job at a time, in a worker when there is one. */
class Runner {
  private worker: Worker | null = null;
  private broken = false;
  private id = 0;
  private local: ReturnType<typeof pumpJob> | null = null;
  private job: BreakJob | null = null;
  private onProgress: (p: SearchProgress) => void = () => {};
  private onDone: (r: BreakJobResult) => void = () => {};

  start(
    job: BreakJob,
    onProgress: (p: SearchProgress) => void,
    onDone: (r: BreakJobResult) => void,
  ) {
    this.stop();
    this.id++;
    this.job = job;
    this.onProgress = onProgress;
    this.onDone = onDone;
    const w = this.ensureWorker();
    if (w) this.send({ type: 'start', id: this.id, job });
    else this.runLocal(job);
  }

  pause() {
    this.local?.pause();
    this.send({ type: 'pause' });
  }

  resume() {
    this.local?.resume();
    this.send({ type: 'resume' });
  }

  stop() {
    this.local?.stop();
    this.local = null;
    this.send({ type: 'stop' });
    this.job = null;
  }

  dispose() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  private send(msg: ToWorker) {
    this.worker?.postMessage(msg);
  }

  private runLocal(job: BreakJob) {
    const id = this.id;
    this.local = pumpJob(
      job,
      CHECK_BUDGET_MS,
      (p) => id === this.id && this.onProgress(p),
      (r) => {
        if (id !== this.id) return;
        this.local = null;
        this.job = null;
        this.onDone(r);
      },
      (fn) => window.setTimeout(fn, 0),
    );
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    if (typeof Worker === 'undefined') {
      this.broken = true;
      return null;
    }
    try {
      const w = new Worker(new URL('./breakit.worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.id !== this.id) return;
        if (msg.type === 'progress') this.onProgress(msg.progress);
        else {
          this.job = null;
          this.onDone(msg.result);
        }
      };
      // A host that refuses the worker, such as an editor webview's policy,
      // says so here. The job carries on in this thread from the start.
      w.onerror = () => {
        this.broken = true;
        w.terminate();
        this.worker = null;
        if (this.job) this.runLocal(this.job);
      };
      this.worker = w;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

/** What a closed panel works from: nothing, so a drag costs it nothing. */
const CLOSED: Topology = { nodes: [], edges: [] };

export function useBreakSearch(open: boolean, topology: Topology): BreakSearch {
  const { nodes, edges, seed } = topology;
  // Every derivation below hangs off this, and a drag makes new nodes each
  // frame, so while the panel is shut it is the empty design.
  const design = useMemo(
    () => (open ? searchDesign({ nodes, edges, seed }) : CLOSED),
    [open, nodes, edges, seed],
  );
  const templates = useMemo(() => breakGoals(design), [design]);
  const designSig = useMemo(
    () => breakKey(design, { metric: 'errorRate', max: 0 }, DEFAULT_OPTIONS),
    [design],
  );

  const [baselineState, setBaselineState] = useState<{
    sig: string;
    ids: string[];
    baselines: Baseline[];
  } | null>(null);
  const [goalId, setGoalId] = useState('up');
  const [maxes, setMaxes] = useState<Readonly<Record<string, number>>>({});
  const [opts, setOpts] = useState<BreakOptions>(DEFAULT_OPTIONS);
  const [view, setView] = useState<BreakView>({ status: 'picking' });
  const [remembered, setRemembered] = useState<Attack[][]>([]);
  const [results, setResults] = useState<ReadonlyMap<string, BreakView>>(
    () => new Map(),
  );

  const runnerRef = useRef<Runner | null>(null);
  const runner = () => (runnerRef.current ??= new Runner());

  /* Closing ends the worker. A search it was running is gone with it, so
     the panel opens on the goals next time. Adjusted during render, so a
     search that can no longer finish is never shown. */
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && (view.status === 'searching' || view.status === 'stopped')) {
      setView({ status: 'picking' });
    }
  }
  useEffect(() => {
    if (open) return;
    runnerRef.current?.dispose();
    runnerRef.current = null;
  }, [open]);
  useEffect(() => () => runnerRef.current?.dispose(), []);

  const ids = useMemo(() => templates.map((t) => t.id), [templates]);
  const baselines =
    baselineState &&
    baselineState.sig === designSig &&
    baselineState.ids.join('|') === ids.join('|')
      ? baselineState.baselines
      : null;

  /* The fault-free figures, for the defaults and the line under each goal.
     Only while nothing else is running: a search measures its own. */
  const busy = view.status === 'searching' || view.status === 'stopped';
  useEffect(() => {
    if (!open || busy || baselines) return;
    const timer = window.setTimeout(() => {
      runner().start(
        { kind: 'baseline', design, goals: templates.map((t) => t.goal) },
        () => {},
        (r) => {
          if (r.kind === 'baseline') {
            setBaselineState({ sig: designSig, ids, baselines: r.baselines });
          }
        },
      );
    }, BASELINE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open, busy, baselines, design, designSig, templates, ids]);

  const template = templates.find((t) => t.id === goalId);
  const goalGone = template === undefined;
  const shown = template ?? templates[0];
  const maxOf = useCallback(
    (id: string) => {
      const i = templates.findIndex((t) => t.id === id);
      if (i < 0) return 0;
      return (
        maxes[id] ?? defaultMax(templates[i].goal, baselines?.[i].worst.actual ?? null)
      );
    },
    [templates, maxes, baselines],
  );
  const goal = useMemo<Goal>(
    () => ({ ...shown.goal, max: maxOf(shown.id) }),
    [shown, maxOf],
  );
  const singlePoints = useMemo(() => singlePointsFor(design, goal), [design, goal]);

  const keyOf = useCallback(
    (o: BreakOptions) =>
      `${breakKey(design, goal, o)}:${remembered.map(scheduleKey).join('|')}`,
    [design, goal, remembered],
  );

  const start = useCallback(
    (harder = false) => {
      const o = harder ? { ...opts, budget: HARDER_BUDGET } : opts;
      const key = keyOf(o);
      const known = results.get(key);
      if (known) {
        setView(known);
        return;
      }
      setView({ status: 'searching', progress: null });
      const ranDesign = design;
      const ranGoal = goal;
      const sig = designSig;
      runner().start(
        { kind: 'search', design, goal, opts: o, remembered },
        // A report already in flight when Stop was pressed does not undo it.
        (progress) =>
          setView((v) =>
            v.status === 'searching' ? { status: 'searching', progress } : v,
          ),
        (r) => {
          if (r.kind !== 'search') return;
          const done: BreakView = {
            status: 'done',
            result: r.result,
            design: ranDesign,
            goal: ranGoal,
            designSig: sig,
          };
          setView(done);
          setResults((m) => {
            const next = new Map(m);
            next.set(key, done);
            while (next.size > KEPT_RESULTS) {
              const oldest = next.keys().next().value;
              if (oldest === undefined) break;
              next.delete(oldest);
            }
            return next;
          });
        },
      );
    },
    [opts, keyOf, results, design, goal, designSig, remembered],
  );

  const stop = useCallback(() => {
    runnerRef.current?.pause();
    setView((v) =>
      v.status === 'searching' ? { status: 'stopped', progress: v.progress } : v,
    );
  }, []);

  const keepGoing = useCallback(() => {
    runnerRef.current?.resume();
    setView((v) =>
      v.status === 'stopped' ? { status: 'searching', progress: v.progress } : v,
    );
  }, []);

  const backToGoals = useCallback(() => {
    runnerRef.current?.stop();
    setView({ status: 'picking' });
  }, []);

  const remember = useCallback((attacks: Attack[]) => {
    setRemembered((list) => {
      const key = scheduleKey(attacks);
      return [attacks, ...list.filter((a) => scheduleKey(a) !== key)].slice(
        0,
        MAX_REMEMBERED,
      );
    });
  }, []);

  const setMax = useCallback((id: string, max: number) => {
    setMaxes((m) => ({ ...m, [id]: max }));
  }, []);

  const stale = view.status === 'done' && view.designSig !== designSig;

  return {
    templates,
    baselines,
    goalId: shown.id,
    setGoalId,
    goal,
    maxOf,
    setMax,
    opts,
    setOpts,
    singlePoints,
    view,
    stale,
    goalGone,
    remembered,
    start,
    stop,
    keepGoing,
    backToGoals,
    remember,
  };
}
