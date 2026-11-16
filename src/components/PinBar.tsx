import { Pin, X } from 'lucide-react';
import type { SystemStats } from '../sim/types';
import { compareRows, pinLabel, type PinnedRun } from './pinnedRun';
import { Term } from './Tooltip';
import './PinBar.css';

/**
 * The row across the top of the charts strip that holds a pinned run.
 *
 * Before a pin it is one button. After, it reads the three numbers a student
 * watches in the bar as "then → now", so the effect of a change is a single
 * line rather than a figure to remember. The charts draw the pinned samples
 * as a dotted line on the same axes.
 */
export interface PinBarProps {
  pin: PinnedRun | null;
  system: SystemStats;
  /** The slider's load now, to judge goodput only at the pinned load. */
  rps: number;
  /** False while there is nothing measured to pin. */
  canPin: boolean;
  onPin: () => void;
  onClear: () => void;
}

const TONE_CLASS = { better: 'is-ok', worse: 'is-danger', same: '' } as const;
const TONE_WORD = { better: ', better', worse: ', worse', same: '' } as const;

export function PinBar({ pin, system, rps, canPin, onPin, onClear }: PinBarProps) {
  if (!pin) {
    if (!canPin) return null;
    return (
      <div className="mx-pin" data-strip-skip="">
        <button type="button" className="btn btn-sm mx-pin-btn" onClick={onPin}>
          <Pin size={14} aria-hidden="true" />
          Pin this run
        </button>
        <span className="mx-pin-hint">
          Keep these numbers, change something, then compare.
        </span>
      </div>
    );
  }

  const rows = compareRows(pin, system, rps);
  return (
    <div className="mx-pin is-pinned" data-strip-skip="">
      <span className="mx-pin-label">
        <span className="mx-pin-swatch" aria-hidden="true" />
        <span className="num">{pinLabel(pin)}</span>
      </span>
      <ul className="mx-pin-rows" aria-label="Pinned run against now">
        {rows.map((r) => (
          <li key={r.name} className="mx-pin-row">
            <span className="mx-pin-name">
              <Term id={r.term}>{r.name}</Term>
            </span>
            <span className="num mx-pin-then">{r.then}</span>
            <span className="mx-pin-arrow" aria-hidden="true">
              →
            </span>
            <span className="sr-only"> now </span>
            <span className={`num mx-pin-now ${TONE_CLASS[r.tone]}`}>{r.now}</span>
            {r.tone === 'same' ? null : (
              <span className="sr-only">{TONE_WORD[r.tone]}</span>
            )}
          </li>
        ))}
      </ul>
      <span className="mx-pin-actions">
        <button
          type="button"
          className="btn btn-sm mx-pin-btn"
          onClick={onPin}
          disabled={!canPin}
        >
          Pin again
        </button>
        <button
          type="button"
          className="btn btn-sm btn-icon mx-pin-clear"
          aria-label="Clear the pinned run"
          title="Clear the pinned run"
          onClick={onClear}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
