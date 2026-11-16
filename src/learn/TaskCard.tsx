import { useEffect, useLayoutEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { SimSnapshot, Topology } from '../sim/types';
import { toneClass } from '../components/format';
import { figViews, probeValue, type TaskAction, type TaskStep } from './exampleTask';
import type { TaskView } from './useExampleTask';
import './TaskCard.css';

/* ==========================================================================
   "Your task": what to do with the example on the canvas, step by step.

   Each step ticks itself off from the run (see exampleTask.ts), so the card
   never says something happened before the engine shows it. Not modal and
   not focus-taking: the lesson is in using the real controls. It sits where
   the tour does, top right and clear of an open inspector, and folds to a
   one-line chip in the same corner when hidden.
   ========================================================================== */

export interface TaskCardProps {
  view: Exclude<TaskView, { kind: 'none' }>;
  /** The example's name, for "Reload". */
  exampleName: string;
  topology: Topology;
  snapshot: SimSnapshot | null;
  selectedId: string | null;
  /**
   * Folded whatever the student chose, because something else needs the
   * room: the inspector sheet on a phone. The chip still opens it.
   */
  squeezed: boolean;
  /** The next step on the path, or null after the last one. */
  next: { name: string; open: () => void } | null;
  onSetLoad: (rps: number) => void;
  onSelect: (nodeId: string) => void;
  onHide: (hidden: boolean) => void;
  onReload: () => void;
  onOpenPath: () => void;
  /**
   * Take focus once, on the card or its chip: set when the student opened
   * this example from somewhere that has gone (the path dialog, the tour, a
   * brief's Next), so a keyboard does not start over from the top bar.
   */
  takeFocus: boolean;
  onFocusTaken: () => void;
}

/** "Set it to 560", "Select Database": a step's button, or null when it is moot. */
function actionOf(
  step: TaskStep,
  topology: Topology,
  snapshot: SimSnapshot | null,
  selectedId: string | null,
): (TaskAction & { label: string }) | null {
  const a = step.action;
  if (!a) return null;
  if (a.kind === 'load') {
    const now = snapshot ? probeValue({ of: 'load' }, topology, snapshot) : null;
    return now === a.rps
      ? null
      : { ...a, label: `Set it to ${a.rps.toLocaleString('en-US')}` };
  }
  if (selectedId === a.node) return null;
  const label = topology.nodes.find((n) => n.id === a.node)?.label;
  return label ? { ...a, label: `Select ${label}` } : null;
}

/** The inspector row whose label reads `label`, or null while it is not shown. */
function fieldRow(label: string): Element | null {
  for (const l of document.querySelectorAll('.ins label.row-k')) {
    if (l.textContent?.trim() === label) return l.closest('.ins-field-row, .ins-field');
  }
  return null;
}

export function TaskCard({
  view,
  exampleName,
  topology,
  snapshot,
  selectedId,
  squeezed,
  next,
  onSetLoad,
  onSelect,
  onHide,
  onReload,
  onOpenPath,
  takeFocus,
  onFocusTaken,
}: TaskCardProps) {
  const { task } = view;
  const ringRef = useRef<Element | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  /* A step's button goes once it has done its work. Pressed from a
     keyboard, focus goes on to the field it rang, or the card, rather than
     dropping to the page. A pointer press leaves focus alone. */
  const refocusRef = useRef(false);
  const total = task.steps.length;
  const live = view.kind === 'live' ? view : null;
  const at = live ? Math.min(live.progress.step, total) : 0;
  const done = live?.done ?? false;
  const countText = done
    ? 'done'
    : view.kind === 'stale'
      ? 'not checking'
      : `${at + 1} of ${total}`;

  /* The field the step asks to change, ringed once its part is selected,
     as the tour rings its own. Rerun on every render, since the inspector
     mounts its fields after a selection lands. */
  // Squeezed still rings it: that is the phone's inspector sheet, where the
  // field is.
  const stepNow = live && !done && !view.hidden ? task.steps[at] : undefined;
  const wantField =
    stepNow?.field &&
    stepNow.action?.kind === 'select' &&
    selectedId === stepNow.action.node
      ? stepNow.field
      : null;
  useLayoutEffect(() => {
    const next = wantField ? fieldRow(wantField) : null;
    const prev = ringRef.current;
    if (prev === next) return;
    prev?.removeAttribute('data-tour-ring');
    next?.setAttribute('data-tour-ring', '');
    next?.scrollIntoView?.({ block: 'center' });
    ringRef.current = next;
  });
  useLayoutEffect(() => {
    if (!refocusRef.current) return;
    const at = document.activeElement;
    if (at === null || at === document.body) {
      refocusRef.current = false;
      /* The value itself, not the minus button in front of it, which is
         also disabled at one instance: focus() on that did nothing and left
         focus on the page. */
      const row = ringRef.current;
      const field =
        row?.querySelector<HTMLElement>(
          'input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
        ) ?? row?.querySelector<HTMLElement>('button:not(:disabled)');
      field?.focus();
      if (!field || document.activeElement !== field)
        (cardRef.current ?? chipRef.current)?.focus();
    } else if (!cardRef.current?.contains(at)) refocusRef.current = false;
  });
  const hiddenNow = view.hidden || squeezed;
  useEffect(() => {
    if (!takeFocus) return;
    (hiddenNow ? chipRef.current : cardRef.current)?.focus({ preventScroll: true });
    onFocusTaken();
  }, [takeFocus, hiddenNow, onFocusTaken]);
  useEffect(
    () => () => {
      ringRef.current?.removeAttribute('data-tour-ring');
      ringRef.current = null;
    },
    [],
  );

  if (hiddenNow) {
    return (
      <div className="task" data-chrome="task">
        <button
          ref={chipRef}
          type="button"
          className="btn btn-sm task-chip"
          aria-label={`Show your task, ${countText}`}
          onClick={(e) => {
            refocusRef.current = e.detail === 0;
            onHide(false);
          }}
        >
          <span>
            Your task, <span className="task-chip-count">{countText}</span>
          </span>
        </button>
      </div>
    );
  }

  const current = live && !done ? task.steps[at] : undefined;
  const action = current ? actionOf(current, topology, snapshot, selectedId) : null;
  const figs =
    current?.figs && snapshot ? figViews(current.figs, topology, snapshot) : [];
  const holdMs = current?.holdMs ?? 0;
  const held = live && holdMs > 0 ? live.progress.heldMs : 0;

  return (
    <div className="task" data-chrome="task">
      <section
        ref={cardRef}
        className="card-float task-card"
        data-spot-avoid
        aria-labelledby="task-title"
        tabIndex={-1}
      >
        <header className="card-float-head">
          <p className="task-count" aria-live="polite">
            Your task, <span className="task-count-n">{countText}</span>
          </p>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={(e) => {
              // From a keyboard, focus goes on to the chip that replaces it.
              refocusRef.current = e.detail === 0;
              onHide(true);
            }}
          >
            Hide
          </button>
        </header>

        {done ? (
          <>
            <h2 id="task-title" className="card-float-title">
              What you learned
            </h2>
            <p className="task-learned">{task.learned}</p>
            <div className="card-float-actions">
              {next ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={next.open}
                >
                  Next: {next.name}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={onOpenPath}
                >
                  Open the learning path
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 id="task-title" className="card-float-title">
              {task.goal}
            </h2>
            {view.kind === 'stale' ? (
              <>
                <p className="task-note">
                  You changed the diagram, so this task has stopped checking. Load the
                  example again to start it over.
                </p>
                <div className="card-float-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={onReload}
                  >
                    Reload {exampleName}
                  </button>
                </div>
              </>
            ) : (
              <ol className="task-steps">
                {task.steps.map((step, i) => {
                  const skipped = live?.progress.skipped.includes(i) ?? false;
                  const state = skipped
                    ? 'skipped'
                    : i < at
                      ? 'done'
                      : i === at
                        ? 'now'
                        : 'next';
                  return (
                    <li
                      key={i}
                      className="task-step"
                      data-at={state}
                      aria-current={state === 'now' ? 'step' : undefined}
                    >
                      <span className="task-mark" aria-hidden="true">
                        {state === 'done' ? <Check size={14} strokeWidth={2} /> : i + 1}
                      </span>
                      <span className="task-step-body">
                        <span className="task-step-text">
                          {step.text}
                          {state === 'done' ? (
                            <span className="sr-only"> Done.</span>
                          ) : null}
                          {state === 'skipped' ? (
                            <span className="task-skipped"> Skipped</span>
                          ) : null}
                        </span>
                        {state === 'now' && figs.length > 0 ? (
                          <ul className="task-figs" aria-label="Right now">
                            {figs.map((f) => (
                              <li
                                key={f.label}
                                className="task-fig"
                                data-health={f.health}
                              >
                                <span
                                  className={`task-fig-v num ${toneClass(f.health) ?? ''}`}
                                >
                                  {f.value}
                                  {f.unit ? (
                                    <span className="unit">{f.unit}</span>
                                  ) : null}
                                </span>{' '}
                                <span className="task-fig-k">{f.label}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {state === 'now' && held > 0 ? (
                          <span className="task-hold">
                            Holding:{' '}
                            <span className="num">{Math.floor(held / 1000)}</span> of{' '}
                            <span className="num">{holdMs / 1000}</span> seconds
                          </span>
                        ) : null}
                        {state === 'now' && action ? (
                          <span className="task-act">
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={(e) => {
                                // detail is 0 for a click made with Enter or Space.
                                refocusRef.current = e.detail === 0;
                                if (action.kind === 'load') onSetLoad(action.rps);
                                else onSelect(action.node);
                              }}
                            >
                              {action.label}
                            </button>
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </section>
    </div>
  );
}
