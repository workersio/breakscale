import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Challenge, ChallengeResult, Goal, GoalMetric } from '../sim/challenge';
import { CHECK_SEEDS, DEFAULT_WARMUP_S, DEFAULT_WINDOW_S } from '../sim/judge';
import type { BudgetUse, RunResult, Unjudgeable, Verdict } from '../sim/judge';
import type { FailureReason } from '../sim/types';
import type { CheckView } from '../useChallengeCheck';
import { formatCount, formatGoalMs, formatGoalPct, formatShareDown } from './format';
import { KIND_NAME } from './nodeVisuals';
import './Challenge.css';

/**
 * The active brief, and how the design is doing against it.
 *
 * Sits over the canvas rather than in a dialog, because the whole point is
 * to read the requirement and watch the numbers move at the same time. A
 * brief you have to close to see its effect is a quiz question.
 *
 * The reader is a student, so the open panel says only what they need to act
 * on: the brief, each goal with the checked number and whether it was met,
 * one verdict line, the budget and a hint. Everything else (the live
 * reading, which run decided it, the time window, watching a run, checking
 * again) sits behind "Details".
 *
 * Two readings, kept apart on purpose. The live one moves with the run on
 * screen, on whatever seed and faults it has, and it never says "met": a
 * number that happens to sit under the line for a second is not a design
 * that meets it. The check is what passes. It runs the design on its own,
 * the same way every time, and its answer only changes when the design does.
 */
export interface ChallengePanelProps {
  challenge: Challenge;
  /** The live reading, or null before the first snapshot. */
  live: ChallengeResult | null;
  /** False while nothing completes, when the live percentiles mean nothing. */
  liveFlowing: boolean;
  check: CheckView;
  budget: BudgetUse | null;
  hintsShown: number;
  onHint: () => void;
  onCheckAgain: () => void;
  /** Load one of the check's runs onto the canvas and play it. */
  onWatch: (seed: number) => void;
  /** Null when there is nothing to start over from. */
  onStartOver: (() => void) | null;
  /** Null for the last brief. */
  onNext: (() => void) | null;
  onLeave: () => void;
  /** Moves focus to the brief each time it changes from 0, for a new start. */
  focusSignal: number;
  /** A node's name in the start design, for saying which one a fault hits. */
  nameOf: (id: string) => string;
  /**
   * The inspector is open beside the panel. The brief folds to its heading
   * while it is, so the component being changed stays in view; the chip
   * still says how the check went, and the reader can open it again.
   */
  besideInspector?: boolean;
  /**
   * Open folded on a new start. For a phone, where the open brief would
   * cover the diagram it is about.
   */
  foldOnStart?: boolean;
  /**
   * The panel's height in CSS px and whether it is folded, each time either
   * changes, and null once as it goes away. On a phone the panel is a sheet
   * over the foot of the canvas, and the shell keeps the diagram framed in
   * what is left above it.
   */
  onSheetResize?: (height: number | null, shut: boolean) => void;
}

/** A goal's name in its row. The percentile names are taught, not assumed. */
const LABEL: Record<GoalMetric, string> = {
  p99: 'Slowest 1 in 100 requests (p99)',
  p95: 'Slowest 1 in 20 requests (p95)',
  errorRate: 'Requests lost',
  lostWrites: 'Saves that never reached the database',
  lostJobs: 'Accepted jobs that failed later',
  queueDepth: 'Jobs still waiting in the queue',
};

/**
 * A goal's name, with the traffic source it is about when it is about one:
 * "Checkout users: requests lost".
 */
function goalName(goal: Goal, nameOf: (id: string) => string): string {
  if (goal.route === undefined) return LABEL[goal.metric];
  const label = LABEL[goal.metric];
  return `${nameOf(goal.route)}: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** Goals that count things, which read "or fewer" rather than "or less". */
const COUNTED: ReadonlySet<GoalMetric> = new Set([
  'lostWrites',
  'lostJobs',
  'queueDepth',
]);

/** A reading against a goal, rounded toward failing it. See format.ts. */
function formatGoal(metric: GoalMetric, value: number | null): string {
  switch (metric) {
    case 'errorRate':
      return formatGoalPct(value);
    case 'lostWrites':
    case 'lostJobs':
    case 'queueDepth':
      return formatCount(value);
    case 'p99':
    case 'p95':
      return formatGoalMs(value);
  }
}

/** The line a goal has to stay under: "200ms or less", "none". */
function limit(goal: Goal): string {
  if (goal.max === 0) return 'none';
  const n = formatGoal(goal.metric, goal.max);
  return COUNTED.has(goal.metric) ? `${n} or fewer` : `${n} or less`;
}

/** One sentence on a missed goal, for the verdict line. */
function missLine(
  goal: Goal,
  actual: number | null,
  nameOf: (id: string) => string,
): string {
  const a = formatGoal(goal.metric, actual);
  const one = actual === 1;
  const end = `and the goal is ${limit(goal)}.`;
  const requests =
    goal.route === undefined ? 'requests' : `requests from ${nameOf(goal.route)}`;
  switch (goal.metric) {
    case 'p99':
      return `The slowest 1 in 100 ${requests} took ${a}, ${end}`;
    case 'p95':
      return `The slowest 1 in 20 ${requests} took ${a}, ${end}`;
    case 'errorRate':
      return `${a} of ${requests} were lost, ${end}`;
    case 'lostWrites':
      return `${a} ${one ? 'save' : 'saves'} never reached the database, ${end}`;
    case 'lostJobs':
      return `${a} accepted ${one ? 'job' : 'jobs'} failed later, ${end}`;
    case 'queueDepth':
      return `${a} ${one ? 'job was' : 'jobs were'} still waiting in the queue at the end, ${end}`;
  }
}

/**
 * Why requests were lost, finishing "Most lost requests were ...". One line,
 * from the run's own counts, so a failed check points somewhere instead of
 * only saying no.
 */
const REASON_PHRASE: Record<FailureReason, string> = {
  shed: 'turned away because every slot was taken and the line was full',
  timeout: 'given up on because the caller stopped waiting',
  error: 'answered with an error',
  crashed: 'lost when a component crashed',
  'no-route': 'sent somewhere with nothing connected to take them',
  depth: 'passed along too many hops',
  throttled: 'refused by a rate limiter',
  rejected: 'refused by an open circuit breaker',
  partitioned: 'stopped by a cut connection',
  'packet-loss': 'dropped by a connection losing packets',
  'region-down': 'sent while no region was serving',
  'conn-refused': 'refused because every connection was taken',
  unauthorized: 'refused because they failed authentication',
  'bulkhead-full': 'refused by a full bulkhead',
  'acquire-timeout': 'dropped after waiting too long for a bulkhead slot',
  deprioritized: 'dropped to make room for more important traffic',
};

/** The commonest reason a run lost requests, as a sentence, or null. */
function reasonLine(run: RunResult): string | null {
  let top: FailureReason | null = null;
  let most = 0;
  for (const [reason, n] of Object.entries(run.failuresByReason) as [
    FailureReason,
    number,
  ][]) {
    if (n > most) {
      most = n;
      top = reason;
    }
  }
  if (top === null || run.failed <= 0) return null;
  const phrase = REASON_PHRASE[top];
  if (most >= run.failed) return `Every lost request was ${phrase}.`;
  const share = formatShareDown(most / run.failed);
  return most * 2 > run.failed
    ? `Most lost requests (${share}) were ${phrase}.`
    : `The largest share of lost requests (${share}) were ${phrase}.`;
}

/** "run 2", numbered the way the reader counts them rather than by seed. */
function runName(run: RunResult): string {
  const i = CHECK_SEEDS.indexOf(run.seed);
  return `run ${i >= 0 ? i + 1 : run.seed}`;
}

type VerdictTone = 'ok' | 'danger' | 'warn';

/** A verdict as one word and one sentence on why. */
interface VerdictLine {
  word: string;
  why: string;
  tone: VerdictTone;
}

function verdictLine(verdict: Verdict, nameOf: (id: string) => string): VerdictLine {
  switch (verdict.status) {
    case 'passed':
      return {
        word: 'Passed',
        why: `Your design met every goal in all ${CHECK_SEEDS.length} test runs.`,
        tone: 'ok',
      };
    case 'goal-missed': {
      const miss = verdict.deciding.goals.find((g) => !g.met);
      return {
        word: 'Not yet',
        why: miss ? missLine(miss.goal, miss.actual, nameOf) : 'A goal was missed.',
        tone: 'danger',
      };
    }
    case 'nothing-completed':
      return {
        word: 'Not yet',
        why: 'No request got an answer at all.',
        tone: 'danger',
      };
    case 'falling-behind':
      return {
        word: 'Not yet',
        why: `Only ${formatShareDown(verdict.deciding.keptUp)} of the requests sent got an answer by the end, and the rest were still waiting.`,
        tone: 'danger',
      };
    case 'over-budget':
      return {
        word: 'Over budget',
        why: `This design adds ${verdict.budget.used} ${verdict.budget.used === 1 ? 'slot' : 'slots'} and the brief allows ${verdict.budget.allowed}.`,
        tone: 'warn',
      };
    case 'unjudgeable':
      return {
        word: 'Cannot check yet',
        why: unjudgeableLine(verdict.why, nameOf),
        tone: 'warn',
      };
  }
}

/** The verdict as it is announced. */
function headline(verdict: Verdict, nameOf: (id: string) => string): string {
  const { word, why } = verdictLine(verdict, nameOf);
  return `${word}. ${why}`;
}

function unjudgeableLine(why: Unjudgeable, nameOf: (id: string) => string): string {
  switch (why.reason) {
    case 'no-traffic':
      return 'There is no client left to send traffic. Put one back.';
    case 'fault-target-missing':
      return `The brief breaks ${nameOf(why.target)} on purpose, and this design no longer has one it can break that way. Put it back.`;
    case 'traffic-added':
      return 'This design has a client the brief does not. Take the new one out.';
    case 'component-missing':
      return `Requests no longer reach every ${KIND_NAME[why.kind].toLowerCase()} the brief started with. Put it back or connect it again.`;
    case 'connection-cut':
      return `Requests no longer get from ${nameOf(why.from)} to ${nameOf(why.to)}. Connect them again; you can put new parts in between.`;
    case 'connection-added':
      return `${nameOf(why.from)} now sends requests straight to ${nameOf(why.to)}, which skips part of the system. Take that connection out.`;
    case 'shortcut-added':
      return why.allowed > 0
        ? `This brief allows one new ${KIND_NAME[why.kind].toLowerCase()}, and this design adds more. A row of them hides the problem instead of fixing it, so take the extra ones out.`
        : `A new ${KIND_NAME[why.kind].toLowerCase()} would answer requests before the work behind it is done, and this brief does not allow one. Take it out.`;
    case 'dead-end-added':
      return `${nameOf(why.nodeId)} answers requests without passing them on, so they never reach the rest of the system. Connect it onward or take it out.`;
  }
}

type Tone = 'stale' | 'checking' | 'passed' | 'failed' | 'warn';

function toneOf(view: CheckView): Tone {
  if (view.status !== 'verdict') return view.status;
  switch (view.verdict.status) {
    case 'passed':
      return 'passed';
    case 'goal-missed':
    case 'nothing-completed':
    case 'falling-behind':
      return 'failed';
    case 'over-budget':
    case 'unjudgeable':
      return 'warn';
  }
}

function chipOf(view: CheckView): string {
  if (view.status === 'stale') return view.hadVerdict ? 'Changed' : 'Not checked yet';
  if (view.status === 'checking') return 'Checking';
  switch (view.verdict.status) {
    case 'passed':
      return 'Passed';
    case 'goal-missed':
    case 'nothing-completed':
      return 'Not yet';
    case 'falling-behind':
      return 'Falling behind';
    case 'over-budget':
      return 'Over budget';
    case 'unjudgeable':
      return 'Cannot check';
  }
}

/**
 * The goals, once, each with what the check measured and whether it was
 * met. Until the check has a reading for this design, a row shows only the
 * goal and what is happening, never a number left over from the last one.
 */
function GoalList({
  challenge,
  check,
  deciding,
  nameOf,
}: {
  challenge: Challenge;
  check: CheckView;
  deciding: RunResult | null;
  nameOf: (id: string) => string;
}) {
  const pending = check.status === 'checking' ? 'Checking' : 'Not checked yet';
  return (
    <ul className="chal-goals">
      {challenge.goals.map((goal, i) => {
        // By position: two goals can share a metric when one is on a route.
        const at = deciding?.goals[i];
        const row =
          at && at.goal.metric === goal.metric && at.goal.route === goal.route
            ? at
            : undefined;
        const state = row ? (row.met ? 'is-met' : 'is-unmet') : 'is-pending';
        return (
          <li key={i} className={`chal-goal ${state}`}>
            <span className="chal-goal-name">{goalName(goal, nameOf)}</span>
            <span className="num chal-goal-actual">
              {row ? formatGoal(goal.metric, row.actual) : null}
            </span>
            <span className="chal-goal-target">Goal: {limit(goal)}</span>
            <span className="chal-goal-state">
              {row ? (row.met ? 'Met' : 'Not met') : pending}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The live reading: numbers only, never met or not. */
function LiveRows({
  rows,
  nameOf,
}: {
  rows: ChallengeResult['goals'];
  nameOf: (id: string) => string;
}) {
  return (
    <ul className="chal-goals">
      {rows.map((g, i) => (
        <li key={i} className="chal-goal is-live">
          <span className="chal-goal-name">{goalName(g.goal, nameOf)}</span>
          <span className="num chal-goal-actual">
            {formatGoal(g.goal.metric, g.actual)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={open ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  );
}

export function ChallengePanel({
  challenge,
  live,
  liveFlowing,
  check,
  budget,
  hintsShown,
  onHint,
  onCheckAgain,
  onWatch,
  onStartOver,
  onNext,
  onLeave,
  focusSignal,
  nameOf,
  besideInspector = false,
  foldOnStart = false,
  onSheetResize,
}: ChallengePanelProps) {
  const headingId = useId();
  const bodyId = useId();
  const detailsId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const lastHintRef = useRef<HTMLParagraphElement | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  /* The reader's own choice, and a second one for while the inspector is
     open, which starts folded each time it opens. Kept apart so closing the
     inspector gives back whatever the reader had. */
  const [collapsed, setCollapsed] = useState(foldOnStart);
  const [folded, setFolded] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const shut = besideInspector ? folded : collapsed;

  /* A new start opens the panel again, or folds it on a phone, and closes
     the details. Adjusted during render rather than in an effect, so the
     wrong state is never painted for a frame first. The same for the
     inspector opening. */
  const [seenSignal, setSeenSignal] = useState(focusSignal);
  if (seenSignal !== focusSignal) {
    setSeenSignal(focusSignal);
    setCollapsed(foldOnStart);
    setDetailsOpen(false);
  }
  const [seenBeside, setSeenBeside] = useState(besideInspector);
  if (seenBeside !== besideInspector) {
    setSeenBeside(besideInspector);
    if (besideInspector) setFolded(true);
  }

  /* Report the panel's size to the shell. Observed rather than computed:
     the folded line, the open brief and a verdict that wraps are all
     whatever height the text makes them. The fold state goes with it so the
     shell can tell folding from text growing. Read through refs, so the
     observer subscribes once for the panel's life. */
  const shutRef = useRef(shut);
  const onSheetResizeRef = useRef(onSheetResize);
  useLayoutEffect(() => {
    shutRef.current = shut;
    onSheetResizeRef.current = onSheetResize;
  });
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      onSheetResizeRef.current?.(el.getBoundingClientRect().height, shutRef.current);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onSheetResizeRef.current?.(null, shutRef.current);
    };
  }, []);

  /* Focus goes to the brief when one is started by hand, so a screen reader
     lands on what it asks rather than on a menu that has closed. Not after a
     reload: the reader did not just ask for it. */
  useEffect(() => {
    if (focusSignal > 0) headingRef.current?.focus();
  }, [focusSignal]);

  const tone = toneOf(check);
  const verdict = check.status === 'verdict' ? check.verdict : null;
  const passed = verdict?.status === 'passed';

  /* A pass brings the lesson and the way on, at the foot of the panel.
     Scrolled to once, as the pass lands, and not again when the panel
     re-renders with the same verdict. The panel's scroll position is outside
     React, which is why this is an effect. */
  const passKey = passed ? verdict.designKey : null;
  useEffect(() => {
    if (passKey === null) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    footRef.current?.scrollIntoView?.({
      block: 'nearest',
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [passKey]);

  /* The last hint takes its button with it, so focus goes to the hint it
     brought rather than falling to the page. */
  const hintFocus = useRef(false);
  useEffect(() => {
    if (!hintFocus.current) return;
    hintFocus.current = false;
    lastHintRef.current?.focus();
  }, [hintsShown]);
  const deciding = verdict && 'deciding' in verdict ? verdict.deciding : null;
  const line = verdict ? verdictLine(verdict, nameOf) : null;
  const reason =
    verdict && verdict.status !== 'passed' && deciding ? reasonLine(deciding) : null;
  const shown = challenge.hints.slice(0, hintsShown);
  const warmS = challenge.warmupS ?? DEFAULT_WARMUP_S;
  const endS = warmS + (challenge.windowS ?? DEFAULT_WINDOW_S);

  return (
    <section
      ref={sectionRef}
      className={`chal is-${tone}${shut ? ' is-collapsed' : ''}`}
      aria-labelledby={headingId}
      data-chrome=""
    >
      <header className="chal-head">
        <div className="chal-head-text">
          <p className="label chal-kicker">Challenge</p>
          <h2 id={headingId} ref={headingRef} className="chal-name" tabIndex={-1}>
            {challenge.name}
          </h2>
        </div>
        {/* Only while folded: open, the verdict line says the same. */}
        <span className={`label chal-chip is-${tone}`}>{chipOf(check)}</span>
        <button
          type="button"
          className="btn btn-sm btn-icon chal-collapse"
          aria-expanded={!shut}
          aria-controls={bodyId}
          aria-label={shut ? 'Show the brief' : 'Hide the brief'}
          title={shut ? 'Show the brief' : 'Hide the brief'}
          onClick={() =>
            besideInspector ? setFolded((f) => !f) : setCollapsed((c) => !c)
          }
        >
          <Chevron open={!shut} />
        </button>
      </header>

      {/* Announced, not only drawn: the check finishes on its own a moment
          after the reader stops, and someone who cannot see the line change
          needs to hear that it did. Polite, so it waits for whatever they
          were doing. */}
      <p className="sr-only" role="status">
        {verdict ? headline(verdict, nameOf) : ''}
      </p>

      <div id={bodyId} className="chal-body" hidden={shut}>
        <p className="chal-brief">{challenge.brief}</p>

        <GoalList
          challenge={challenge}
          check={check}
          deciding={deciding}
          nameOf={nameOf}
        />

        {line ? (
          <p className={`chal-verdict is-${line.tone}`}>
            <strong className="chal-verdict-word">{line.word}.</strong> {line.why}
          </p>
        ) : (
          <p className="chal-verdict is-pending">
            {check.status === 'checking'
              ? 'Checking…'
              : check.status === 'stale' && check.hadVerdict
                ? 'You changed the design. It gets checked again a second after you stop.'
                : 'Your design gets checked a second after it stops changing.'}
          </p>
        )}

        {budget ? (
          <p className={`chal-budget${budget.used > budget.allowed ? ' is-over' : ''}`}>
            {budget.allowed === 0
              ? "You can't add any slots here."
              : `You can add up to ${budget.allowed} more ${budget.allowed === 1 ? 'slot' : 'slots'}.`}{' '}
            Used: <span className="num">{budget.used}</span>.
          </p>
        ) : null}

        {passed ? (
          /* The explanation arrives only now, and only while the pass is for
             the design on the canvas: the check view is a verdict only while
             its key is current. Shown from the start it is the answer, and
             the brief stops being one. */
          <p className="chal-lesson">{challenge.lesson}</p>
        ) : (
          <div className="chal-help">
            {shown.map((text, i) => (
              <p
                key={i}
                ref={i === shown.length - 1 ? lastHintRef : undefined}
                className="chal-hint"
                tabIndex={-1}
              >
                {text}
              </p>
            ))}
            {hintsShown < challenge.hints.length ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost chal-more"
                onClick={() => {
                  hintFocus.current = hintsShown + 1 === challenge.hints.length;
                  onHint();
                }}
              >
                {hintsShown === 0 ? 'Give me a hint' : 'Another hint'}
              </button>
            ) : null}
          </div>
        )}

        <div className="chal-details">
          <button
            type="button"
            className="btn btn-sm btn-ghost chal-details-toggle"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            Details
            <Chevron open={detailsOpen} />
          </button>
          <div id={detailsId} className="chal-details-body" hidden={!detailsOpen}>
            <div
              className="chal-block"
              role="group"
              aria-labelledby={`${detailsId}-live`}
            >
              <p id={`${detailsId}-live`} className="label chal-block-title">
                Right now on screen
              </p>
              {live && liveFlowing ? (
                <div className="chal-live">
                  <LiveRows rows={live.goals} nameOf={nameOf} />
                </div>
              ) : (
                <p className="chal-note">Nothing is getting through right now.</p>
              )}
              <p className="chal-note">
                These numbers move with the run on screen. Only the check decides a
                pass.
              </p>
            </div>

            <div
              className="chal-block"
              role="group"
              aria-labelledby={`${detailsId}-check`}
            >
              <p id={`${detailsId}-check`} className="label chal-block-title">
                The check
              </p>
              <p className="chal-note">
                The check plays your design {CHECK_SEEDS.length} times, each with
                slightly different random traffic. It counts from {warmS}s to {endS}s of
                each run.
              </p>
              {check.status === 'checking' ? (
                <>
                  <div
                    className="chal-progress"
                    role="progressbar"
                    aria-label="Checking your design"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.floor(check.done * 100)}
                  >
                    <span
                      className="chal-progress-fill"
                      style={{
                        transform: `scaleX(${Math.min(1, Math.max(0, check.done))})`,
                      }}
                    />
                  </div>
                  <p className="chal-note">
                    Checking run {check.run + 1} of {CHECK_SEEDS.length}
                  </p>
                </>
              ) : null}
              {deciding ? (
                <p className="chal-note">
                  {passed ? 'Closest call' : 'Decided by'}: {runName(deciding)}, with{' '}
                  <span className="num">{formatCount(deciding.arrived)}</span> requests
                  counted.
                </p>
              ) : null}
              {reason ? <p className="chal-note">{reason}</p> : null}
              {verdict?.status === 'over-budget' ? (
                <p className="chal-note">
                  A slot is one request a component can work on at once. Take some away
                  and it gets checked.
                </p>
              ) : null}
              <div className="chal-actions">
                {deciding ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onWatch(deciding.seed)}
                  >
                    Watch {runName(deciding)}
                  </button>
                ) : null}
                {/* Kept in place while a check runs, so pressing it does not
                    drop keyboard focus to the page. */}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  aria-disabled={check.status === 'checking' ? true : undefined}
                  onClick={check.status === 'checking' ? undefined : onCheckAgain}
                >
                  Check again
                </button>
              </div>
            </div>
          </div>
        </div>

        <div ref={footRef} className="chal-foot">
          {passed && onNext ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={onNext}>
              Next challenge
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={onLeave}>
            Back to my design
          </button>
          {onStartOver ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                onStartOver();
                // The button goes once the design is the brief's start again,
                // so focus goes to the top of the brief instead of the page.
                headingRef.current?.focus();
              }}
            >
              Start over
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
