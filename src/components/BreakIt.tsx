import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { HARDER_BUDGET } from '../sim/breakit';
import type { AttackKind, BreakOptions, SearchProgress } from '../sim/breakit';
import type { Goal } from '../sim/challenge';
import type { SimNode } from '../sim/types';
import type { BreakSearch } from '../useBreakSearch';
import {
  baselineSentence,
  closestLine,
  effectSentence,
  faultPhrase,
  goalLine,
  phaseLine,
  scheduleSentence,
  singlePointLines,
  triedLine,
} from './breakCopy';
import type { Names } from './breakCopy';
import './Challenge.css';
import './BreakIt.css';

/**
 * "Can you break it?": pick what has to hold, and Breakscale throws faults
 * at the design until it gives way or runs out of tries.
 *
 * Docks where a brief does and uses its panel, sheet on a phone included,
 * because the canvas has to stay in view: the parts under attack are marked
 * on it. Non-modal, so nothing traps focus; Escape stops a search, and
 * closes the panel when nothing is running.
 */
export interface BreakPanelProps {
  search: BreakSearch;
  names: Names;
  /** The components the reader can leave alone. */
  nodes: readonly SimNode[];
  onClose: () => void;
  onWatch: () => void;
  onReplayLink: () => void;
  /**
   * While a replay plays: where it is, in a line. The panel folds to it.
   * Null otherwise.
   */
  watchLine: string | null;
  foldOnStart?: boolean;
  onSheetResize?: (height: number | null, shut: boolean) => void;
}

const KIND_LABEL: Record<AttackKind, string> = {
  crash: 'Crashes',
  'crash-instance': 'Losing one machine',
  slow: 'Slowdowns',
  errors: 'Glitches (errors)',
  cut: 'Cut cables',
};

/** A template's name in the radio group. */
function templateLabel(goal: Goal, names: Names): string {
  const who = goal.route === undefined ? null : names.node(goal.route);
  switch (goal.metric) {
    case 'errorRate':
      return who ? `Keep ${who} up` : 'Keep everyone up';
    case 'p99':
    case 'p95':
      return who ? `Keep ${who} fast` : 'Stay fast';
    case 'lostWrites':
      return 'No lost writes';
    case 'lostJobs':
      return 'No lost jobs';
    case 'queueDepth':
      return '';
  }
}

/** The sentence around a template's number, and the number's unit. */
function templateSentence(goal: Goal): { before: string; after: string; unit: string } {
  const their = goal.route === undefined ? '' : 'of their ';
  switch (goal.metric) {
    case 'errorRate':
      return {
        before: 'Fewer than',
        after: `% of ${their}requests fail.`,
        unit: 'percent',
      };
    case 'p99':
    case 'p95':
      return {
        before: `99 in 100 ${their}requests finish within`,
        after: 'ms.',
        unit: 'milliseconds',
      };
    case 'lostWrites':
      return { before: 'At most', after: 'saved writes are lost.', unit: 'writes' };
    default:
      return { before: 'At most', after: 'accepted jobs fail.', unit: 'jobs' };
  }
}

/**
 * A goal's number. What the reader types is kept as typed, so the field can
 * be cleared and retyped; it counts once it reads as a number of 0 or more,
 * and a blur puts back the last one that did.
 */
function GoalNumber({
  id,
  value,
  describedBy,
  label,
  onCommit,
}: {
  id: string;
  value: number;
  describedBy: string;
  label: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      id={id}
      className="brk-num num"
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      value={draft ?? String(value)}
      aria-describedby={describedBy}
      aria-label={label}
      onChange={(e) => {
        const text = e.currentTarget.value;
        setDraft(text);
        const v = Number(text);
        if (text.trim() !== '' && Number.isFinite(v) && v >= 0) onCommit(v);
      }}
      onBlur={() => setDraft(null)}
    />
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

/** The heading for the state the panel is in. */
function headingOf(search: BreakSearch): string {
  const v = search.view;
  if (v.status !== 'done') return 'Can you break it?';
  switch (v.result.status) {
    case 'broke':
      return v.result.fromRemembered ? 'Still breaks.' : 'Broke it.';
    case 'held':
      return 'Held.';
    case 'alreadyBroken':
      return 'Already broken.';
  }
}

/** The one line a screen reader hears when a verdict lands. */
function announcement(search: BreakSearch, names: Names): string {
  const v = search.view;
  if (v.status === 'searching') return v.progress ? phaseLine(v.progress.phase) : '';
  if (v.status === 'stopped') return 'Stopped.';
  if (v.status !== 'done') return '';
  const r = v.result;
  switch (r.status) {
    case 'broke':
      return `${headingOf(search)} ${scheduleSentence(r.attacks, names)} ${effectSentence(r.run, v.goal, names)}`;
    case 'held':
      return `Held across ${r.tried} fault ${r.tried === 1 ? 'schedule' : 'schedules'}.`;
    case 'alreadyBroken':
      return `Already broken with no faults. ${effectSentence(r.baseline.worst, v.goal, names)}`;
  }
}

export function BreakPanel({
  search,
  names,
  nodes,
  onClose,
  onWatch,
  onReplayLink,
  watchLine,
  foldOnStart = false,
  onSheetResize,
}: BreakPanelProps) {
  const headingId = useId();
  const bodyId = useId();
  const baselineId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(foldOnStart);
  /** Folded to one line while fixing or watching. */
  const [fixing, setFixing] = useState(false);
  const view = search.view;
  const shut = collapsed;

  /* Report the sheet's size to the shell, as the brief's panel does. */
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

  /* Focus goes to a verdict's heading as it lands, so a screen reader is
     where the answer is. Keyed on the result object, which is new per run. */
  const result = view.status === 'done' ? view.result : null;
  useEffect(() => {
    if (result) headingRef.current?.focus();
  }, [result]);

  /* A new search unfolds the panel again. Adjusted during render, so the
     folded bar is never painted for a frame over a running search. */
  const [seenStatus, setSeenStatus] = useState(view.status);
  if (seenStatus !== view.status) {
    setSeenStatus(view.status);
    if (view.status === 'searching') setFixing(false);
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (view.status === 'searching') search.stop();
    else onClose();
  };

  const heading = headingOf(search);
  const verdictTone =
    result?.status === 'broke' || result?.status === 'alreadyBroken'
      ? 'is-failed'
      : result?.status === 'held'
        ? 'is-passed'
        : '';

  return (
    <section
      ref={sectionRef}
      className={`chal brk ${verdictTone}${shut ? ' is-collapsed' : ''}`}
      role="region"
      aria-labelledby={headingId}
      data-chrome=""
      onKeyDown={onKeyDown}
    >
      <header className="chal-head">
        <div className="chal-head-text">
          {view.status === 'done' ? (
            <p className="label chal-kicker">Can you break it?</p>
          ) : null}
          <h2 id={headingId} ref={headingRef} className="chal-name" tabIndex={-1}>
            {heading}
          </h2>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-icon chal-collapse"
          aria-expanded={!shut}
          aria-controls={bodyId}
          aria-label={shut ? 'Show the panel' : 'Fold the panel'}
          title={shut ? 'Show the panel' : 'Fold the panel'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <Chevron open={!shut} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <p className="sr-only" role="status">
        {announcement(search, names)}
      </p>

      {watchLine !== null ? (
        <p className="brk-pill" aria-live="off">
          {watchLine}
        </p>
      ) : null}

      <div id={bodyId} className="chal-body" hidden={shut}>
        {search.stale && view.status === 'done' ? (
          <div className="brk-stale">
            <p className="chal-note">
              You changed the design after this ran. A replay plays it as it was.
            </p>
            <button type="button" className="btn btn-sm" onClick={() => search.start()}>
              Run again
            </button>
          </div>
        ) : null}

        {view.status === 'picking' ? (
          <Picking
            search={search}
            names={names}
            nodes={nodes}
            baselineId={baselineId}
          />
        ) : view.status === 'searching' || view.status === 'stopped' ? (
          <Searching
            search={search}
            names={names}
            progress={view.progress}
            stopped={view.status === 'stopped'}
          />
        ) : fixing && result?.status === 'broke' ? (
          <div className="brk-fixing">
            <p className="chal-note">
              Broke at: {scheduleSentence(result.attacks, names)} Change the design,
              then run it again. Those faults are tried first.
            </p>
            <div className="chal-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => search.start()}
              >
                Run again
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setFixing(false)}
              >
                Show the verdict
              </button>
            </div>
          </div>
        ) : view.status === 'done' ? (
          <Verdict
            search={search}
            names={names}
            onWatch={() => {
              // Folded to the replay's line, so the run can be seen.
              setCollapsed(true);
              onWatch();
            }}
            onReplayLink={onReplayLink}
            onFix={() => {
              if (result?.status === 'broke') search.remember(result.attacks);
              setFixing(true);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function Picking({
  search,
  names,
  nodes,
  baselineId,
}: {
  search: BreakSearch;
  names: Names;
  nodes: readonly SimNode[];
  baselineId: string;
}) {
  const { templates, baselines, opts } = search;
  const set = (patch: Partial<BreakOptions>) => search.setOpts({ ...opts, ...patch });
  const toggleKind = (k: AttackKind) =>
    set({
      kinds: opts.kinds.includes(k)
        ? opts.kinds.filter((x) => x !== k)
        : [...opts.kinds, k],
    });
  const toggleProtect = (id: string) =>
    set({
      protect: opts.protect.includes(id)
        ? opts.protect.filter((x) => x !== id)
        : [...opts.protect, id],
    });
  const selected = templates.findIndex((t) => t.id === search.goalId);
  const base = selected >= 0 ? baselines?.[selected] : undefined;
  const targets = nodes.filter((n) => n.kind !== 'client');

  return (
    <>
      <p className="chal-brief">
        Pick what has to hold. Breakscale throws faults at your design until it fails,
        or until it runs out of tries.
      </p>
      {search.goalGone ? (
        <p className="chal-note">That traffic source is gone. Pick another goal.</p>
      ) : null}
      <fieldset className="brk-goals">
        <legend className="label chal-block-title">What has to hold</legend>
        {templates.map((t) => {
          const on = t.id === search.goalId;
          const s = templateSentence(t.goal);
          const inputId = `brk-max-${t.id}`;
          return (
            <div key={t.id} className={`brk-goal${on ? ' is-on' : ''}`}>
              <label className="brk-goal-head">
                <input
                  type="radio"
                  name="brk-goal"
                  checked={on}
                  onChange={() => search.setGoalId(t.id)}
                />
                <span className="brk-goal-name">{templateLabel(t.goal, names)}</span>
              </label>
              {on ? (
                <p className="brk-goal-sentence">
                  <label htmlFor={inputId}>{s.before}</label>{' '}
                  <GoalNumber
                    id={inputId}
                    value={search.maxOf(t.id)}
                    describedBy={baselineId}
                    label={`${s.before} how many ${s.unit}`}
                    onCommit={(v) => search.setMax(t.id, v)}
                  />{' '}
                  {s.after}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <p id={baselineId} className="chal-note">
        {base
          ? `${baselineSentence(base.worst, search.goal, names)} That is the worst of three runs of traffic.`
          : 'Measuring it with no faults…'}
      </p>

      {search.singlePoints.length > 0 ? (
        <div className="chal-block brk-spof">
          <p className="label chal-block-title">Single points of failure</p>
          <ul className="brk-list">
            {singlePointLines(search.singlePoints, names).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="chal-note">
            Each of these is a single point of failure: lose one and that traffic has
            nowhere to go, which breaks any goal. So the search only slows them and
            takes down single machines.
          </p>
          <label className="brk-check">
            <input
              type="checkbox"
              checked={opts.includeSinglePoints}
              onChange={(e) => set({ includeSinglePoints: e.currentTarget.checked })}
            />
            Crash and cut them too
          </label>
        </div>
      ) : null}

      <details className="brk-more">
        <summary>What can go wrong</summary>
        <fieldset className="brk-kinds">
          <legend className="sr-only">Kinds of fault</legend>
          {(Object.keys(KIND_LABEL) as AttackKind[]).map((k) => (
            <label key={k} className="brk-check">
              <input
                type="checkbox"
                checked={opts.kinds.includes(k)}
                onChange={() => toggleKind(k)}
              />
              {KIND_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <label className="brk-check">
          Up to{' '}
          <select
            value={opts.maxFaults}
            onChange={(e) =>
              set({ maxFaults: Number(e.currentTarget.value) as 1 | 2 | 3 })
            }
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>{' '}
          faults at once
        </label>
        {targets.length > 0 ? (
          <fieldset className="brk-kinds">
            <legend className="chal-note">Leave these alone:</legend>
            {targets.map((n) => (
              <label key={n.id} className="brk-check">
                <input
                  type="checkbox"
                  checked={opts.protect.includes(n.id)}
                  onChange={() => toggleProtect(n.id)}
                />
                {names.node(n.id)}
              </label>
            ))}
          </fieldset>
        ) : null}
      </details>

      <div className="chal-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={opts.kinds.length === 0}
          onClick={() => search.start()}
        >
          Try to break it
        </button>
      </div>
    </>
  );
}

function Searching({
  search,
  names,
  progress,
  stopped,
}: {
  search: BreakSearch;
  names: Names;
  progress: SearchProgress | null;
  stopped: boolean;
}) {
  const tried = progress?.tried ?? 0;
  const budget = progress?.budget ?? search.opts.budget;
  const shrinking = progress?.phase === 'shrink';
  const holds = progress?.notes.filter((n) => n.kind === 'holds').length ?? 0;
  return (
    <>
      {stopped ? (
        <p className="chal-note">
          Stopped after {tried} of {budget}. Nothing broke it yet.
        </p>
      ) : (
        <p className="chal-note">{progress ? phaseLine(progress.phase) : 'Starting'}</p>
      )}
      <div
        className="chal-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={tried}
        aria-valuetext={`${tried} of ${budget} tried`}
      >
        <span
          className="chal-progress-fill"
          style={{
            transform: `scaleX(${budget > 0 ? Math.min(1, tried / budget) : 0})`,
          }}
        />
      </div>
      <p className="brk-count">
        <span className="num">{tried}</span> of <span className="num">{budget}</span>{' '}
        tried
        {shrinking ? (
          <>
            , then <span className="num">{progress?.shrinkTried ?? 0}</span> smaller
            versions
          </>
        ) : null}
      </p>
      {progress && progress.current.length > 0 && !stopped ? (
        <p className="chal-note brk-now" aria-hidden="true">
          Now: {progress.current.map((a) => faultPhrase(a, names)).join(' and ')}
        </p>
      ) : null}
      {holds > 0 ? (
        <p className="chal-note">
          {holds === 1
            ? 'The break from last time holds now. Looking for another way in.'
            : `${holds} breaks from before hold now. Looking for another way in.`}
        </p>
      ) : null}
      {progress?.notes
        .filter((n) => n.kind === 'gone')
        .map((n, i) => (
          <p key={i} className="chal-note">
            {n.kind === 'gone'
              ? `${names.node(n.target)} is gone, so that one no longer applies.`
              : null}
          </p>
        ))}
      {!shrinking ? (
        <p className="chal-note">
          {closestLine(progress?.closest ?? null, search.goal, names)}
          {progress?.closest && progress.closest.score >= 0.5
            ? ` ${goalLine(search.goal)}`
            : ''}
        </p>
      ) : null}
      <div className="chal-actions">
        {stopped ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={search.keepGoing}
            >
              Keep going
            </button>
            <button type="button" className="btn btn-sm" onClick={search.backToGoals}>
              Change the goal
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={search.stop}>
            Stop
          </button>
        )}
      </div>
    </>
  );
}

function Verdict({
  search,
  names,
  onWatch,
  onReplayLink,
  onFix,
}: {
  search: BreakSearch;
  names: Names;
  onWatch: () => void;
  onReplayLink: () => void;
  onFix: () => void;
}) {
  const view = search.view;
  if (view.status !== 'done') return null;
  const r = view.result;
  if (r.status === 'alreadyBroken') {
    return (
      <>
        <p className="brk-verdict">
          It is already broken with no faults.{' '}
          {effectSentence(r.baseline.worst, view.goal, names)}{' '}
          {goalLine(view.goal, r.baseline.worst)}
        </p>
        <div className="chal-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={search.backToGoals}
          >
            Change the goal
          </button>
        </div>
      </>
    );
  }
  const fixed = r.notes.filter((n) => n.kind === 'holds').length;
  const gone = r.notes.filter((n) => n.kind === 'gone');
  if (r.status === 'held') {
    return (
      <>
        <p className="brk-verdict">
          Held across {r.tried} fault {r.tried === 1 ? 'schedule' : 'schedules'}.
        </p>
        <p className="chal-note">
          {triedLine(r.bySize)} Each landed between 10s and 15s, and the goal was
          measured from 5s to 35s on three runs of traffic.
        </p>
        <p className="chal-note">{closestLine(r.closest, view.goal, names)}</p>
        {fixed > 0 ? (
          <p className="chal-note">
            You fixed{' '}
            {fixed === 1 ? 'the way it broke last time' : `${fixed} ways it broke`}.
          </p>
        ) : null}
        {gone.map((n, i) => (
          <p key={i} className="chal-note">
            {n.kind === 'gone'
              ? `${names.node(n.target)} is gone, so that break no longer applies.`
              : null}
          </p>
        ))}
        <div className="chal-actions">
          {/* Only when it used every try it had and more are on offer. Fewer
              means it ran out of new schedules, and more tries find none. */}
          {r.budget < HARDER_BUDGET && r.tried >= r.budget ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => search.start(true)}
            >
              Try harder
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={search.backToGoals}>
            Change the goal
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="brk-verdict brk-schedule">{scheduleSentence(r.attacks, names)}</p>
      <p className="brk-verdict">
        {effectSentence(r.run, view.goal, names)} {goalLine(view.goal, r.run)}
      </p>
      <p className="chal-note brk-small">
        {r.fromRemembered
          ? 'The same faults as last time.'
          : r.shrinkTried > 0
            ? `Found on try ${r.foundAt}, then made smaller in ${r.shrinkTried} more.`
            : `Found on try ${r.foundAt}.`}{' '}
        It broke on this run of traffic and on another one too.
      </p>
      <div className="chal-actions brk-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={onWatch}>
          Watch the replay
        </button>
        <button type="button" className="btn btn-sm" onClick={onReplayLink}>
          Replay link
        </button>
        <button type="button" className="btn btn-sm" onClick={onFix}>
          Try to fix it
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={search.backToGoals}
        >
          Change the goal
        </button>
      </div>
    </>
  );
}
