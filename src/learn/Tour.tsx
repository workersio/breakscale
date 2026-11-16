import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SimSnapshot, Topology } from '../sim/types';
import { toneClass } from '../components/format';
import { MIN_RATE } from './bottleneck';
import {
  STEP_COUNT,
  TOUR_RPS,
  readingOf,
  stepNumber,
  totalSlots,
  tourFigures,
  type TourFigure,
} from './tourSteps';
import type { TourState } from './useTour';
import { scrollWithin } from './scrollWithin';
import './Tour.css';

interface TourProps {
  tour: TourState;
  topology: Topology;
  snapshot: SimSnapshot | null;
  selectedId: string | null;
  rps: number;
  onSetLoad: (rps: number) => void;
  onSelect: (nodeId: string) => void;
  onOpenPath: () => void;
  /** The tour is put away from its own card, so focus can go on to what follows. */
  onHandOff: () => void;
}

/** How long a line may take to clear after a fix before "try more" is fair. */
const SETTLE_MS = 4000;

/** The field step 3 points at, found by its label as the student reads it. */
const SLOTS_LABEL = 'Slots per instance';

/** The control a stage points at, or null. Read from the DOM: it belongs to other components. */
function targetFor(kind: string, fieldShown: boolean): Element | null {
  if (kind === 'load') {
    // On a phone the load block is `display: contents` and draws no box; the
    // track row is the slider's own.
    const load = document.querySelector('.traffic-load');
    return load && getComputedStyle(load).display === 'contents'
      ? load.querySelector('.traffic-load-track')
      : load;
  }
  if (kind !== 'fix' || !fieldShown) return null;
  for (const label of document.querySelectorAll('.ins label.row-k')) {
    if (label.textContent?.trim() === SLOTS_LABEL) {
      return label.closest('.ins-field-row, .ins-field');
    }
  }
  return null;
}

/**
 * The first-visit walkthrough: a small card that says what to do next and
 * moves on when the engine shows it happened. Not modal: nothing is dimmed
 * and the canvas keeps every gesture, because the lesson is in using the
 * real controls.
 */
export function Tour({
  tour,
  topology,
  snapshot,
  selectedId,
  rps,
  onSetLoad,
  onSelect,
  onOpenPath,
  onHandOff,
}: TourProps) {
  const { stage } = tour;
  const finish = () => {
    tour.end();
    onHandOff();
  };
  const cardRef = useRef<HTMLElement | null>(null);
  const ringRef = useRef<Element | null>(null);

  /* Focus comes to the card when it opens, and again on each new step if it
     was in the card (a pressed button that has now gone). Never taken from
     the slider or a field the student is using. */
  const step = stepNumber(stage);
  /* A step the student reached from the inspector leaves focus there, so
     the card's new heading is said instead of being moved to. */
  const [said, setSaid] = useState('');
  const titleRef = useRef('');
  const firstStep = useRef(true);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const active = document.activeElement;
    if (active === null || active === document.body || card.contains(active)) {
      card.focus({ preventScroll: true });
      setSaid('');
    } else if (!firstStep.current) {
      setSaid(`Tour step ${step} of ${STEP_COUNT}: ${titleRef.current}`);
    }
    firstStep.current = false;
  }, [step]);

  /* The ring on the control this step is about. Rerun on every render, since
     the inspector mounts its fields after a selection lands. */
  const subject = stage.kind === 'load' ? null : stage.nodeId;
  const fieldShown = subject !== null && selectedId === subject;
  useLayoutEffect(() => {
    const next = targetFor(stage.kind, fieldShown);
    const prev = ringRef.current;
    if (prev === next) return;
    prev?.removeAttribute('data-tour-ring');
    next?.setAttribute('data-tour-ring', '');
    if (next && stage.kind === 'fix') scrollWithin(next);
    ringRef.current = next;
  });
  useEffect(
    () => () => {
      ringRef.current?.removeAttribute('data-tour-ring');
      ringRef.current = null;
    },
    [],
  );

  const label =
    subject !== null
      ? (topology.nodes.find((n) => n.id === subject)?.label ?? 'It')
      : null;
  const figures =
    subject !== null && snapshot ? tourFigures(topology, snapshot, subject) : [];
  /** The figures a step shows, in the order the card names them. */
  const pick = (...ids: TourFigure['id'][]) =>
    ids.flatMap((id) => figures.filter((f) => f.id === id));

  let title: string;
  let body: ReactNode;
  let shown: readonly TourFigure[] = [];
  let actions: ReactNode;

  switch (stage.kind) {
    case 'load':
      title = 'Break it on purpose';
      body = (
        <p>
          This slider sets how many requests your users send each second. Drag it up to
          about {TOUR_RPS} and watch what happens.
        </p>
      );
      actions =
        rps < TOUR_RPS ? (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => onSetLoad(TOUR_RPS)}
          >
            Set it to {TOUR_RPS}
          </button>
        ) : null;
      break;
    case 'broken': {
      // Refused work never waits, so "every request" is only true without it.
      const refusing =
        (snapshot ? readingOf(topology, snapshot, stage.nodeId)?.r.refused : 0) ?? 0;
      title = `${label ?? 'It'} filled up`;
      body =
        refusing >= MIN_RATE ? (
          <p>
            Requests now wait in line for a free slot. Once the line is full, the rest
            are turned away.
          </p>
        ) : (
          <p>Every request now waits its turn in line for a free slot.</p>
        );
      shown = pick('slots', 'waiting', 'refused', 'p99', 'failing');
      actions = (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => onSelect(stage.nodeId)}
        >
          Show me the fix
        </button>
      );
      break;
    }
    case 'fix': {
      const now = totalSlots(topology, stage.nodeId);
      const cfg = topology.nodes.find((n) => n.id === stage.nodeId)?.config;
      const at = snapshot ? readingOf(topology, snapshot, stage.nodeId) : null;
      title = 'Give it more room';
      if (!fieldShown) {
        body = <p>Select {label} to see its settings.</p>;
        actions = (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => onSelect(stage.nodeId)}
          >
            Select {label}
          </button>
        );
      } else if (now <= stage.slots) {
        body = (
          <p>
            Each slot is one request {label} can work on at once. Raise {SLOTS_LABEL}{' '}
            from <span className="num">{cfg?.capacity ?? 0}</span> to{' '}
            <span className="num">{(cfg?.capacity ?? 0) * 2}</span>.
          </p>
        );
        shown = pick('slots', 'waiting', 'p99', 'failing');
        actions = null;
      } else if (at?.r.struggling) {
        const since = (snapshot?.system.timeMs ?? 0) - (stage.raisedAtMs ?? 0);
        body =
          since < SETTLE_MS ? (
            <p>
              {label} has <span className="num">{now}</span> slots now. Give the line a
              few seconds to clear.
            </p>
          ) : (
            <p>
              {label} has <span className="num">{now}</span> slots now, but it is still
              full at this load. Try more.
            </p>
          );
        shown = pick('slots', 'waiting', 'p99', 'failing');
        actions = null;
      } else {
        body = <p>That did it. Watch p99 come back down as the line clears.</p>;
        shown = pick('slots', 'waiting', 'p99', 'failing');
        actions = null;
      }
      break;
    }
    case 'fixed': {
      title = 'Fixed';
      body = (
        <p>
          That is the whole loop: add load, find what breaks, fix it. The learning path
          has what to try next.
        </p>
      );
      shown = pick('slots', 'waiting', 'p99', 'failing');
      actions = (
        <>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              tour.end();
              onOpenPath();
            }}
          >
            Open the learning path
          </button>
          <button type="button" className="btn btn-sm" onClick={finish}>
            Done
          </button>
        </>
      );
      break;
    }
  }

  useLayoutEffect(() => {
    titleRef.current = title;
  });

  return (
    <div className="tour" data-chrome="tour">
      <section
        ref={cardRef}
        className="card-float tour-card"
        data-spot-avoid
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            finish();
          }
        }}
      >
        <header className="card-float-head">
          <p className="tour-progress">
            <span className="sr-only">
              Step {step} of {STEP_COUNT}
            </span>
            <span className="tour-dots" aria-hidden="true">
              {Array.from({ length: STEP_COUNT }, (_, i) => (
                <span
                  key={i}
                  className="tour-dot"
                  data-at={i + 1 < step ? 'done' : i + 1 === step ? 'now' : 'next'}
                />
              ))}
            </span>
            <span className="tour-count num" aria-hidden="true">
              {step}/{STEP_COUNT}
            </span>
          </p>
          {stage.kind === 'fixed' ? null : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              title="Skip the tour (Esc)"
              onClick={finish}
            >
              Skip tour
            </button>
          )}
        </header>
        <p className="sr-only" role="status">
          {said}
        </p>
        <h2 id="tour-title" className="card-float-title">
          {title}
        </h2>
        <div id="tour-body" className="tour-body">
          {body}
          {shown.length > 0 ? (
            <ul className="tour-figs" aria-label={`${label ?? 'It'} right now`}>
              {shown.map((f) => (
                <li
                  key={f.id}
                  className="tour-fig"
                  data-figure={f.id}
                  data-health={f.health}
                >
                  <span className={`tour-fig-v num ${toneClass(f.health) ?? ''}`}>
                    {f.value}
                    {f.unit ? <span className="unit">{f.unit}</span> : null}
                  </span>{' '}
                  <span className="tour-fig-k">{f.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {actions ? <div className="card-float-actions">{actions}</div> : null}
      </section>
    </div>
  );
}
