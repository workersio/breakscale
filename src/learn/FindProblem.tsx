import { useEffect, useRef } from 'react';
import { ScanSearch, X } from 'lucide-react';
import type { SimSnapshot, Topology } from '../sim/types';
import { findBottleneck, type Verdict } from './bottleneck';
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

/** The answer in a few words, above the sentence that backs it up. */
function headline(v: Verdict, topology: Topology): string {
  switch (v.kind) {
    case 'problem':
      return `${nameOf(topology, v.nodeId)} is holding things back`;
    case 'on-purpose':
      return 'Working as designed';
    case 'healthy':
      return 'Running fine';
    case 'idle':
      return 'No traffic yet';
  }
}

function nameOf(topology: Topology, id: string): string {
  return topology.nodes.find((n) => n.id === id)?.label ?? 'it';
}

/**
 * The verdict without the part's name in front when the status line and the
 * button already carry it: "Database: all 6 slots busy" reads "All 6 slots
 * busy". Everything after the name is the verdict's own words.
 */
function withoutName(v: Verdict, topology: Topology): string {
  if (v.kind !== 'problem') return v.text;
  const prefix = `${nameOf(topology, v.nodeId)}: `;
  if (!v.text.startsWith(prefix)) return v.text;
  const rest = v.text.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Split after a full stop and a space, so "1.5 a second" stays whole. */
function sentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/).filter((s) => s.length > 0);
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
  // The first sentence is the answer; what follows is why, set quieter.
  const [lead, ...rest] = v ? sentences(withoutName(v, topology)) : [];

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
        <div
          className="card-float fp-answer"
          ref={answerRef}
          data-verdict={v.kind}
          data-spot-avoid
          data-titles-clear
        >
          <header className="fp-head">
            <p className="card-float-title fp-title" aria-hidden="true">
              <span className="fp-dot" aria-hidden="true" />
              {headline(v, topology)}
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
          </header>
          <div className="fp-text" aria-hidden="true">
            <p className="fp-lead">{lead}</p>
            {rest.length > 0 ? <p className="fp-more">{rest.join(' ')}</p> : null}
          </div>
          {target ? (
            <div className="card-float-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onSelect(target)}
              >
                Select {nameOf(topology, target)}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
