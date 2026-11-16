import { useId, useState } from 'react';
import type { ActiveDuplicate, ActiveFailure, ActiveReplyCut } from '../sim/types';
import { formatPct } from './format';
import {
  DEFAULT_DUP_RATE,
  DEFAULT_GLITCH_RATE,
  DEFAULT_LOSS_RATE,
  DEFAULT_PAUSE_MS,
  DUP_RATES,
  DEFAULT_RESTART_DOWN_MS,
  DEFAULT_SLOW_FACTOR,
  GLITCH_RATES,
  LOSS_RATES,
  PAUSE_MS,
  RESTART_DOWN_MS,
  SLOW_FACTORS,
  dupStatus,
  faultStatus,
  formatDownFor,
  formatFactor,
  replyCutStatus,
  strandedStatus,
} from './faultWiring';
import type { CableInfo } from './faultWiring';

/* ------------------------------------------------------------------ *
 * Fault controls
 *
 * Breaking a component on purpose, from the inspector. Every action goes
 * through the engine's record* calls, so it lands in the fault schedule at
 * the current simulated time and Reset plays it back at the same moment.
 *
 * The buttons that would change nothing are aria-disabled rather than
 * disabled. Pressing Crash turns Crash into a no-op, and a real `disabled`
 * would drop keyboard focus onto the page the moment it was pressed. The
 * fault in force is not greyed out like the rest: it reads as pressed, in
 * the danger colours, and says what is happening ("Crashed"), since a grey
 * button read as the one thing you could not do.
 * ------------------------------------------------------------------ */

export interface NodeFaultControlsProps {
  /** The fault in force on this node, or null when it is healthy. */
  fault: ActiveFailure | null;
  /** Every cable into or out of this node. */
  cables: readonly CableInfo[];
  onCrash: () => void;
  /** Take it down, and have it start again by itself `downMs` later. */
  onRestart: (downMs: number) => void;
  /**
   * What else a restart loses on this kind, as a sentence: the writes a
   * store had not put on disk, or the messages a broker held. Absent where
   * losing the work in progress is all.
   */
  restartLoses?: string;
  /**
   * Take one machine down and leave the rest serving. Absent for a node with
   * a single instance, or a kind that cannot lose one, and the row is not
   * shown: with one machine it would be Crash under another name.
   */
  onCrashOne?: () => void;
  /** How many machines the node runs, for the Crash one instance hint. */
  instances?: number;
  /**
   * False for a kind that does no timed work (a gate, a controller, the
   * client), where Slow would change nothing. The row stays, inert, and says
   * why. Defaults to true.
   */
  canSlow?: boolean;
  onSlow: (factor: number) => void;
  /**
   * Stop it for a while, and have it carry on by itself. Absent for a kind
   * that serves no requests, and the row is not shown.
   */
  onPause?: (pauseMs: number) => void;
  onGlitch: (rate: number) => void;
  onFix: () => void;
  onCut: (edgeId: string) => void;
  onRestore: (edgeId: string) => void;
  /**
   * The cable faults, offered on each cable that carries requests, so they
   * are reachable from the keyboard as well as by selecting the cable.
   * Duplicate uses the default share; the cable's own panel picks another.
   */
  onDuplicate?: (edgeId: string, rate: number) => void;
  onUndup?: (edgeId: string) => void;
  onCutReplies?: (edgeId: string) => void;
  onRestoreReplies?: (edgeId: string) => void;
  /** How many entries the fault schedule holds. */
  recorded?: number;
  /** Empty the schedule. Without it, the Forget row is not shown. */
  onForget?: () => void;
}

/** Shared click guard for aria-disabled buttons. */
function guarded(inert: boolean, act: () => void): () => void {
  return () => {
    if (!inert) act();
  };
}

export function NodeFaultControls({
  fault,
  cables,
  onCrash,
  onRestart,
  restartLoses,
  onCrashOne,
  instances = 1,
  canSlow = true,
  onSlow,
  onPause,
  onGlitch,
  onFix,
  onCut,
  onRestore,
  onDuplicate,
  onUndup,
  onCutReplies,
  onRestoreReplies,
  recorded = 0,
  onForget,
}: NodeFaultControlsProps) {
  const id = useId();
  const [factor, setFactor] = useState(DEFAULT_SLOW_FACTOR);
  const [rate, setRate] = useState(DEFAULT_GLITCH_RATE);
  const [downMs, setDownMs] = useState(DEFAULT_RESTART_DOWN_MS);
  const [pauseMs, setPauseMs] = useState(DEFAULT_PAUSE_MS);

  const crashed = fault?.kind === 'crash';
  // Already down, so a restart now would only move the moment it comes back.
  const restartInert = crashed || fault?.kind === 'restart';
  const oneDown = fault?.kind === 'crash-instance';
  const slowSame = fault?.kind === 'slow' && fault.factor === factor;
  const slowInert = !canSlow || slowSame;
  const glitchSame = fault?.kind === 'errors' && fault.rate === rate;
  // A second pause would only move the moment it carries on.
  const paused = fault?.kind === 'pause';
  const healthy = fault === null;

  return (
    <div className="ins-fault">
      <p
        className={healthy ? 'ins-fault-status' : 'ins-fault-status is-danger'}
        role="status"
      >
        {faultStatus(fault)}
      </p>

      <div className="ins-fault-row">
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={crashed}
          aria-pressed={crashed}
          aria-describedby={`${id}-crash`}
          onClick={guarded(crashed, onCrash)}
        >
          {crashed ? 'Crashed' : 'Crash'}
        </button>
        <p id={`${id}-crash`} className="ins-hint">
          Stops it completely. Work it was holding is lost.
        </p>
      </div>

      <div className="ins-fault-row">
        <label className="row-k" htmlFor={`${id}-down`}>
          Down for
        </label>
        <div className="ins-fault-pair">
          <select
            id={`${id}-down`}
            className="ins-number"
            value={downMs}
            onChange={(e) => setDownMs(Number(e.currentTarget.value))}
          >
            {RESTART_DOWN_MS.map((ms) => (
              <option key={ms} value={ms}>
                {formatDownFor(ms)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={restartInert}
            aria-describedby={`${id}-restart`}
            onClick={guarded(restartInert, () => onRestart(downMs))}
          >
            Restart
          </button>
        </div>
        <p id={`${id}-restart`} className="ins-hint">
          Stops it, then it starts again by itself. Work in progress is lost.
          {restartLoses ? ` ${restartLoses}` : ''}
        </p>
      </div>

      {onCrashOne && (
        <div className="ins-fault-row">
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={oneDown}
            aria-pressed={oneDown}
            aria-describedby={`${id}-crash-one`}
            onClick={guarded(oneDown, onCrashOne)}
          >
            {oneDown ? 'One instance down' : 'Crash one instance'}
          </button>
          <p id={`${id}-crash-one`} className="ins-hint">
            Stops one of its {instances} machines. The work on that machine is lost, and
            the other {instances - 1} keep serving with fewer slots between them.
          </p>
        </div>
      )}

      <div className="ins-fault-row">
        <label className="row-k" htmlFor={`${id}-factor`}>
          How much slower
        </label>
        <div className="ins-fault-pair">
          <select
            id={`${id}-factor`}
            className="ins-number"
            value={factor}
            disabled={!canSlow}
            onChange={(e) => setFactor(Number(e.currentTarget.value))}
          >
            {SLOW_FACTORS.map((f) => (
              <option key={f} value={f}>
                {formatFactor(f)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={slowInert}
            aria-pressed={slowSame}
            aria-describedby={`${id}-slow`}
            onClick={guarded(slowInert, () => onSlow(factor))}
          >
            {slowSame ? 'Slowed' : 'Slow'}
          </button>
        </div>
        <p id={`${id}-slow`} className="ins-hint">
          {canSlow
            ? 'Every request takes that many times longer to handle.'
            : 'It does no work of its own that takes time, so there is nothing here to slow down. Try it on a component that handles requests.'}
        </p>
      </div>

      {onPause && (
        <div className="ins-fault-row">
          <label className="row-k" htmlFor={`${id}-pause`}>
            Stall for
          </label>
          <div className="ins-fault-pair">
            <select
              id={`${id}-pause`}
              className="ins-number"
              value={pauseMs}
              onChange={(e) => setPauseMs(Number(e.currentTarget.value))}
            >
              {PAUSE_MS.map((ms) => (
                <option key={ms} value={ms}>
                  {formatDownFor(ms)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={paused}
              aria-describedby={`${id}-pause-hint`}
              onClick={guarded(paused, () => onPause(pauseMs))}
            >
              Stall
            </button>
          </div>
          <p id={`${id}-pause-hint`} className="ins-hint">
            It stops for that long and then carries on, the way a long garbage
            collection pause stalls a program. It returns no errors itself, but callers
            that give up waiting fail or send the same request again.
          </p>
        </div>
      )}

      <div className="ins-fault-row">
        <label className="row-k" htmlFor={`${id}-rate`}>
          Requests that fail
        </label>
        <div className="ins-fault-pair">
          <select
            id={`${id}-rate`}
            className="ins-number"
            value={rate}
            onChange={(e) => setRate(Number(e.currentTarget.value))}
          >
            {GLITCH_RATES.map((r) => (
              <option key={r} value={r}>
                {formatPct(r)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={glitchSame}
            aria-pressed={glitchSame}
            aria-describedby={`${id}-glitch`}
            onClick={guarded(glitchSame, () => onGlitch(rate))}
          >
            {glitchSame ? 'Glitching' : 'Glitch'}
          </button>
        </div>
        <p id={`${id}-glitch`} className="ins-hint">
          It stays up, but that share of its answers are errors.
        </p>
      </div>

      <div className="ins-fault-row">
        {/* The way back is the one next step while something is broken. */}
        <button
          type="button"
          className={healthy ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
          aria-disabled={healthy}
          onClick={guarded(healthy, onFix)}
        >
          Fix
        </button>
      </div>

      {cables.length > 0 && (
        <div className="ins-fault-cables">
          <h3 className="label ins-fault-sub">Connections</h3>
          <ul className="ins-fault-list">
            {cables.map((c) => (
              <li key={c.id} className="ins-fault-cable">
                <span className={c.state === 'connected' ? 'row-k' : 'row-k is-danger'}>
                  {c.label}
                  {c.state === 'connected' ? null : (
                    <span className="sr-only">, cut</span>
                  )}
                </span>
                <CableButton cable={c} onCut={onCut} onRestore={onRestore} named />
                {c.carriesRequests &&
                onDuplicate &&
                onUndup &&
                onCutReplies &&
                onRestoreReplies ? (
                  <CableExtras
                    cable={c}
                    onDuplicate={onDuplicate}
                    onUndup={onUndup}
                    onCutReplies={onCutReplies}
                    onRestoreReplies={onRestoreReplies}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {onDuplicate && cables.some((c) => c.carriesRequests) ? (
            <p className="ins-hint">
              Duplicate delivers {formatPct(DEFAULT_DUP_RATE)} of a connection&rsquo;s
              requests twice. Select the connection itself to pick another share.
            </p>
          ) : null}
        </div>
      )}

      <RecordedFaults recorded={recorded} onForget={onForget} />
    </div>
  );
}

/**
 * How many faults Reset will replay, and the way to stop it. Shown only
 * once there is something to forget, so a run nobody has broken looks
 * the way it always did.
 */
function RecordedFaults({
  recorded,
  onForget,
}: {
  recorded: number;
  onForget: (() => void) | undefined;
}) {
  const id = useId();
  if (recorded === 0 || !onForget) return null;
  return (
    <div className="ins-fault-row ins-fault-recorded">
      <p id={id} className="ins-hint">
        {recorded === 1 ? '1 fault is' : `${recorded} faults are`} saved with this run.
        Reset plays {recorded === 1 ? 'it' : 'them'} again at the same moments, and a
        replay link sends {recorded === 1 ? 'it' : 'them'} along.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        aria-describedby={id}
        onClick={(e) => {
          // Forgetting removes this row, button and all. Hand focus to the
          // control just above it first, so the keyboard is not dropped
          // onto the page.
          const above = e.currentTarget
            .closest('.ins-fault-recorded')
            ?.previousElementSibling?.querySelectorAll<HTMLElement>('button, select');
          above?.[above.length - 1]?.focus();
          onForget();
        }}
      >
        Forget saved faults
      </button>
    </div>
  );
}

/**
 * Cut cable or Restore for one edge. `named` puts the cable's own label in
 * the accessible name, for a list where several buttons share the same
 * visible text.
 */
function CableButton({
  cable,
  onCut,
  onRestore,
  named = false,
}: {
  cable: CableInfo;
  onCut: (edgeId: string) => void;
  onRestore: (edgeId: string) => void;
  named?: boolean;
}) {
  const suffix = named
    ? ` ${cable.label.charAt(0).toLowerCase()}${cable.label.slice(1)}`
    : '';
  if (cable.state === 'connected') {
    return (
      <button
        type="button"
        className="btn btn-sm"
        aria-label={named ? `Cut connection${suffix}` : undefined}
        onClick={() => onCut(cable.id)}
      >
        Cut connection
      </button>
    );
  }
  const inert = cable.state === 'partitioned';
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-label={named ? `Restore${suffix}` : undefined}
      aria-disabled={inert}
      onClick={guarded(inert, () => onRestore(cable.id))}
    >
      Restore
    </button>
  );
}

/** Duplicate and answers-only switches for one row of a node's cable list. */
function CableExtras({
  cable,
  onDuplicate,
  onUndup,
  onCutReplies,
  onRestoreReplies,
}: {
  cable: CableInfo;
  onDuplicate: (edgeId: string, rate: number) => void;
  onUndup: (edgeId: string) => void;
  onCutReplies: (edgeId: string) => void;
  onRestoreReplies: (edgeId: string) => void;
}) {
  const named = `${cable.label.charAt(0).toLowerCase()}${cable.label.slice(1)}`;
  return (
    <span className="ins-fault-cable-extras">
      {cable.duplicating ? (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Deliver once ${named}`}
          onClick={() => onUndup(cable.id)}
        >
          Deliver once
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Duplicate ${formatPct(DEFAULT_DUP_RATE)} of requests ${named}`}
          onClick={() => onDuplicate(cable.id, DEFAULT_DUP_RATE)}
        >
          Duplicate
        </button>
      )}
      {cable.repliesCut ? (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Let answers back ${named}`}
          onClick={() => onRestoreReplies(cable.id)}
        >
          Let answers back
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Cut answers only ${named}`}
          onClick={() => onCutReplies(cable.id)}
        >
          Cut answers
        </button>
      )}
    </span>
  );
}

export interface EdgeFaultControlsProps {
  cable: CableInfo;
  /** Name of the node whose own fault is cutting this cable, if any. */
  cutBy?: string;
  onCut: (edgeId: string) => void;
  onRestore: (edgeId: string) => void;
  /** Delivering some requests twice, or null. */
  dup?: ActiveDuplicate | null;
  /**
   * Deliver some requests twice, and stop. Absent for a cable that carries
   * no requests, such as a controller's, and the rows are not shown.
   */
  onDuplicate?: (edgeId: string, rate: number) => void;
  onUndup?: (edgeId: string) => void;
  /** Losing the answers back across it, or null. */
  replyCut?: ActiveReplyCut | null;
  /** Calls still waiting on answers this cable lost, once it has stopped losing them. */
  stranded?: number;
  /** The caller has no timeout, so it waits for good on a lost answer. */
  callerWaits?: boolean;
  /**
   * Lose every answer back across it, and stop. Absent for a cable that
   * carries no requests, and the row is not shown.
   */
  onCutReplies?: (edgeId: string) => void;
  onRestoreReplies?: (edgeId: string) => void;
  /** How many entries the fault schedule holds. */
  recorded?: number;
  /** Empty the schedule. Without it, the Forget row is not shown. */
  onForget?: () => void;
}

/** The same cable control, for a single selected connection. */
export function EdgeFaultControls({
  cable,
  cutBy,
  onCut,
  onRestore,
  dup = null,
  onDuplicate,
  onUndup,
  replyCut = null,
  stranded = 0,
  callerWaits = false,
  onCutReplies,
  onRestoreReplies,
  recorded = 0,
  onForget,
}: EdgeFaultControlsProps) {
  // "Connected." beside "losing every answer" reads as a contradiction, so
  // while a fault rides on a connected cable this line says what still works.
  const status =
    cable.state === 'connected'
      ? dup !== null || replyCut !== null || stranded > 0
        ? 'Requests get through.'
        : 'Connected.'
      : cable.state === 'cut'
        ? 'Cut. Nothing crosses this connection until you restore it.'
        : cutBy
          ? `Cut because ${cutBy} is cut off from its connections. Fix ${cutBy} to reconnect it.`
          : 'Cut because a component at one end is cut off from its connections. Fix that component to reconnect it.';
  return (
    <div className="ins-fault">
      <p
        className={
          cable.state === 'connected'
            ? 'ins-fault-status'
            : 'ins-fault-status is-danger'
        }
        role="status"
      >
        {status}
      </p>
      {/* Always mounted, with only the text changing: a live region added
          to the page already holding its words is often not read out. */}
      <p
        className={dup !== null ? 'ins-fault-status is-danger' : 'sr-only'}
        role="status"
      >
        {dup !== null ? dupStatus(dup) : ''}
      </p>
      <p
        className={
          replyCut !== null || stranded > 0 ? 'ins-fault-status is-danger' : 'sr-only'
        }
        role="status"
      >
        {replyCut !== null
          ? replyCutStatus(replyCut, callerWaits)
          : stranded > 0
            ? strandedStatus(stranded)
            : ''}
      </p>
      <div className="ins-fault-row">
        <CableButton cable={cable} onCut={onCut} onRestore={onRestore} />
      </div>
      {onDuplicate && onUndup ? (
        <DuplicateRows
          edgeId={cable.id}
          dup={dup}
          onDuplicate={onDuplicate}
          onUndup={onUndup}
        />
      ) : null}
      {onCutReplies && onRestoreReplies ? (
        <ReplyCutRow
          edgeId={cable.id}
          cut={replyCut !== null}
          callerWaits={callerWaits}
          onCutReplies={onCutReplies}
          onRestoreReplies={onRestoreReplies}
        />
      ) : null}
      <RecordedFaults recorded={recorded} onForget={onForget} />
    </div>
  );
}

/**
 * Deliver some of a cable's requests twice, and stop. A scheduled fault
 * like Cut cable, so it is recorded, and Reset plays it at the same moment.
 */
function DuplicateRows({
  edgeId,
  dup,
  onDuplicate,
  onUndup,
}: {
  edgeId: string;
  dup: ActiveDuplicate | null;
  onDuplicate: (edgeId: string, rate: number) => void;
  onUndup: (edgeId: string) => void;
}) {
  const id = useId();
  const [rate, setRate] = useState(dup?.rate ?? DEFAULT_DUP_RATE);
  // A replay link can carry a share the list does not offer.
  const rates =
    dup === null || DUP_RATES.includes(dup.rate)
      ? DUP_RATES
      : [...DUP_RATES, dup.rate].sort((a, b) => a - b);
  const same = dup?.rate === rate;
  const once = dup === null;
  return (
    <>
      <div className="ins-fault-row">
        <label className="row-k" htmlFor={`${id}-dup`}>
          Requests delivered twice
        </label>
        <div className="ins-fault-pair">
          <select
            id={`${id}-dup`}
            className="ins-number"
            value={rate}
            onChange={(e) => setRate(Number(e.currentTarget.value))}
          >
            {rates.map((r) => (
              <option key={r} value={r}>
                {formatPct(r)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={same}
            aria-describedby={`${id}-dup-hint`}
            onClick={guarded(same, () => onDuplicate(edgeId, rate))}
          >
            Duplicate
          </button>
        </div>
        <p id={`${id}-dup-hint`} className="ins-hint">
          The far end gets that share of requests a second time, the way a network that
          resends a packet can, and does the work again. Idempotency keys there spot the
          copy.
        </p>
      </div>
      <div className="ins-fault-row">
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={once}
          onClick={guarded(once, () => onUndup(edgeId))}
        >
          Deliver once
        </button>
      </div>
    </>
  );
}

/**
 * Lose the answers coming back across a cable, and stop. The cable keeps
 * carrying requests, so this is a separate switch from Cut cable.
 */
function ReplyCutRow({
  edgeId,
  cut,
  callerWaits,
  onCutReplies,
  onRestoreReplies,
}: {
  edgeId: string;
  cut: boolean;
  callerWaits: boolean;
  onCutReplies: (edgeId: string) => void;
  onRestoreReplies: (edgeId: string) => void;
}) {
  const id = useId();
  return (
    <div className="ins-fault-row">
      {cut ? (
        <button
          type="button"
          className="btn btn-sm"
          aria-describedby={id}
          onClick={() => onRestoreReplies(edgeId)}
        >
          Let answers back
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          aria-describedby={id}
          onClick={() => onCutReplies(edgeId)}
        >
          Cut answers only
        </button>
      )}
      <p id={id} className="ins-hint">
        Requests still get through and do their work, but the answers never come back.
        {callerWaits
          ? ' The caller has no timeout, so every call that lost its answer stays stuck, even after you let answers back.'
          : ' The caller waits until its timeout gives up, and with retries it does the work a second time.'}
      </p>
    </div>
  );
}

export interface LinkLossControlsProps {
  /** The share of crossings this connection drops now, 0 to 1. */
  lossRate: number;
  /** Set it. A design edit, so it is saved and undoable, not recorded. */
  onLoss: (lossRate: number) => void;
}

/**
 * Packet loss for a single selected connection. Unlike the fault buttons
 * this changes the design itself, the way a slider does, so it is saved
 * with the design and stays in force after Reset.
 */
export function LinkLossControls({ lossRate, onLoss }: LinkLossControlsProps) {
  const id = useId();
  const [rate, setRate] = useState(lossRate > 0 ? lossRate : DEFAULT_LOSS_RATE);
  // A design loaded from a file can hold a value the list does not offer.
  const rates = LOSS_RATES.includes(lossRate)
    ? LOSS_RATES
    : [...LOSS_RATES, lossRate].sort((a, b) => a - b);
  const same = rate === lossRate;

  return (
    <div className="ins-fault">
      <p
        className={lossRate > 0 ? 'ins-fault-status is-danger' : 'ins-fault-status'}
        role="status"
      >
        {lossRate > 0
          ? `Losing ${formatPct(lossRate)} of the requests sent across it. A caller with retries sends a lost request again.`
          : 'Delivers every request sent across it.'}
      </p>
      <div className="ins-fault-row">
        <label className="row-k" htmlFor={`${id}-loss`}>
          Requests lost on the way
        </label>
        <div className="ins-fault-pair">
          <select
            id={`${id}-loss`}
            className="ins-number"
            value={rate}
            onChange={(e) => setRate(Number(e.currentTarget.value))}
          >
            {rates.map((r) => (
              <option key={r} value={r}>
                {r === 0 ? 'None' : formatPct(r)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={same}
            aria-describedby={`${id}-hint`}
            onClick={guarded(same, () => onLoss(rate))}
          >
            Set loss
          </button>
        </div>
        <p id={`${id}-hint`} className="ins-hint">
          Saved with the design, so it stays after Reset. The component at the other end
          never sees a lost request.
        </p>
      </div>
    </div>
  );
}
