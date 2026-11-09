import { useEffect, useRef } from 'react';
import { ScanSearch, X } from 'lucide-react';
import type { SimSnapshot, Topology } from '../sim/types';
import { findBottleneck } from './bottleneck';
import type { Finding } from './finding';
import './FindProblem.css';

interface FindProblemProps {
  topology: Topology;
  snapshot: SimSnapshot | null;
  /** The answer on show, already passed through `currentFinding`. */
  finding: Finding | null;
  onChange: (finding: Finding | null) => void;
  /** Select the named part, which opens the inspector on it. */
  onSelect: (nodeId: string) => void;
}

/**
 * "Find the problem": one press reads the latest snapshot and says which part
 * is holding the system back, and why, in a sentence; the canvas rings it.
 *
 * Read once per press, not live. A sentence whose numbers changed ten times a
 * second could not be read, and pressing again is how to check after a fix.
 */
export function FindProblem({
  topology,
  snapshot,
  finding,
  onChange,
  onSelect,
}: FindProblemProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  /* Putting the answer away unmounts whatever in it had focus, which would
     drop a keyboard user back at the top of the page. The trigger takes it. */
  const close = () => {
    const active = document.activeElement;
    if (active && answerRef.current?.contains(active)) triggerRef.current?.focus();
    onChange(null);
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  const open = finding !== null;

  /* Escape, or a press on the bare canvas, puts the answer away: the same
     ways out every other temporary layer here has. Pointerdown in the
     capture phase, so the canvas's own handlers cannot hide it. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest('.cv-surface')) return;
      if (t.closest('button, input, select, textarea, a, [data-chrome]')) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  const find = () => {
    if (!snapshot) return;
    onChange({
      verdict: findBottleneck(topology, snapshot),
      atMs: snapshot.system.timeMs,
    });
  };

  const v = finding?.verdict;
  const target = v && v.kind !== 'idle' ? v.nodeId : null;

  return (
    <div className="fp" data-chrome="find-problem">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm fp-trigger"
        onClick={find}
        disabled={!snapshot}
        title="Find what is holding the system back"
      >
        <ScanSearch size={16} strokeWidth={1.75} aria-hidden="true" />
        Find the problem
      </button>
      {/* Always in the accessibility tree, so a screen reader hears each new
          answer. Keyed by the time it was read, so a second press with the
          same words is announced again. The visible copy is hidden from it. */}
      <div className="sr-only" role="status">
        {finding ? <span key={finding.atMs}>{finding.verdict.text}</span> : null}
      </div>
      {v ? (
        <div className="fp-answer" ref={answerRef} data-spot-avoid>
          <p
            className={v.kind === 'problem' ? 'fp-text is-problem' : 'fp-text'}
            aria-hidden="true"
          >
            {v.text}
          </p>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon fp-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={close}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {target ? (
            <button
              type="button"
              className="btn btn-sm fp-select"
              onClick={() => onSelect(target)}
            >
              Select it
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
