import { useId, useState } from 'react';
import type { ActiveFailure } from '../sim/types';
import { formatPct } from './format';
import {
  DEFAULT_GLITCH_RATE,
  DEFAULT_LOSS_RATE,
  DEFAULT_SLOW_FACTOR,
  GLITCH_RATES,
  LOSS_RATES,
  SLOW_FACTORS,
  faultStatus,
  formatFactor,
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
 * would drop keyboard focus onto the page the moment it was pressed.
 * ------------------------------------------------------------------ */

export interface NodeFaultControlsProps {
  /** The fault in force on this node, or null when it is healthy. */
  fault: ActiveFailure | null;
  /** Every cable into or out of this node. */
  cables: readonly CableInfo[];
  onCrash: () => void;
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
  onGlitch: (rate: number) => void;
  onFix: () => void;
  onCut: (edgeId: string) => void;
  onRestore: (edgeId: string) => void;
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
  onCrashOne,
  instances = 1,
  canSlow = true,
  onSlow,
  onGlitch,
  onFix,
  onCut,
  onRestore,
  recorded = 0,
  onForget,
}: NodeFaultControlsProps) {
  const id = useId();
  const [factor, setFactor] = useState(DEFAULT_SLOW_FACTOR);
  const [rate, setRate] = useState(DEFAULT_GLITCH_RATE);

  const crashed = fault?.kind === 'crash';
  const oneDown = fault?.kind === 'crash-instance';
  const slowInert = !canSlow || (fault?.kind === 'slow' && fault.factor === factor);
  const glitchSame = fault?.kind === 'errors' && fault.rate === rate;
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
          className="btn btn-sm btn-danger"
          aria-disabled={crashed}
          aria-describedby={`${id}-crash`}
          onClick={guarded(crashed, onCrash)}
        >
          Crash
        </button>
        <p id={`${id}-crash`} className="ins-hint">
          Stops it completely. Work it was holding is lost.
        </p>
      </div>

      {onCrashOne && (
        <div className="ins-fault-row">
          <button
            type="button"
            className="btn btn-sm btn-danger"
            aria-disabled={oneDown}
            aria-describedby={`${id}-crash-one`}
            onClick={guarded(oneDown, onCrashOne)}
          >
            Crash one instance
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
            className="btn btn-sm btn-danger"
            aria-disabled={slowInert}
            aria-describedby={`${id}-slow`}
            onClick={guarded(slowInert, () => onSlow(factor))}
          >
            Slow
          </button>
        </div>
        <p id={`${id}-slow`} className="ins-hint">
          {canSlow
            ? 'Every request takes that many times longer to handle.'
            : 'It does no work of its own that takes time, so there is nothing here to slow down. Try it on a component that handles requests.'}
        </p>
      </div>

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
            className="btn btn-sm btn-danger"
            aria-disabled={glitchSame}
            aria-describedby={`${id}-glitch`}
            onClick={guarded(glitchSame, () => onGlitch(rate))}
          >
            Glitch
          </button>
        </div>
        <p id={`${id}-glitch`} className="ins-hint">
          It stays up, but that share of its answers are errors.
        </p>
      </div>

      <div className="ins-fault-row">
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={healthy}
          onClick={guarded(healthy, onFix)}
        >
          Fix
        </button>
      </div>

      {cables.length > 0 && (
        <div className="ins-fault-cables">
          <h3 className="label ins-fault-sub">Cables</h3>
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
              </li>
            ))}
          </ul>
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
        onClick={onForget}
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
        className="btn btn-sm btn-danger"
        aria-label={named ? `Cut cable${suffix}` : undefined}
        onClick={() => onCut(cable.id)}
      >
        Cut cable
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

export interface EdgeFaultControlsProps {
  cable: CableInfo;
  /** Name of the node whose own fault is cutting this cable, if any. */
  cutBy?: string;
  onCut: (edgeId: string) => void;
  onRestore: (edgeId: string) => void;
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
  recorded = 0,
  onForget,
}: EdgeFaultControlsProps) {
  const status =
    cable.state === 'connected'
      ? 'Connected.'
      : cable.state === 'cut'
        ? 'Cut. Nothing crosses this cable until you restore it.'
        : cutBy
          ? `Cut because ${cutBy} is cut off from its cables. Fix ${cutBy} to reconnect it.`
          : 'Cut because a component at one end is cut off from its cables. Fix that component to reconnect it.';
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
      <div className="ins-fault-row">
        <CableButton cable={cable} onCut={onCut} onRestore={onRestore} />
      </div>
      <RecordedFaults recorded={recorded} onForget={onForget} />
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
            className={rate > 0 ? 'btn btn-sm btn-danger' : 'btn btn-sm'}
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
