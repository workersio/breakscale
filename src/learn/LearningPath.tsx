import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { Challenge } from '../sim/challenge';
import type { Preset } from '../sim/presets';
import type { ChallengeBadge } from '../challengeWorkspace';
import { LEARNING_PATH, type PathStep } from '../content/learningPath';
import { usePresence } from '../components/presence';
import { badgeById, nextStep, stepStatus, type StepStatus } from './pathProgress';
import '../components/Examples.css';
import './LearningPath.css';

/* ==========================================================================
   The learning path dialog.

   The examples dialog's shell, because opening a step is the same act as
   picking an example or a brief, and it goes through the same handlers, so
   loading one over the student's design keeps the same undo. What it adds
   is an order and a record: the step to do next, and how far through each
   track the student is.

   A list, not a grid of cards. A path is read top to bottom, and numbered
   rows say that where a grid would not.
   ========================================================================== */

export interface LearningPathProps {
  open: boolean;
  onClose: () => void;
  presets: readonly Preset[];
  challenges: readonly Challenge[];
  explored: ReadonlySet<string>;
  badgeOf: (challenge: Challenge) => ChallengeBadge;
  activePresetId: string | null;
  activeChallengeId: string | null;
  onLoadExample: (preset: Preset) => void;
  onStartChallenge: (id: string) => void;
}

const KIND_TEXT = { example: 'Example', challenge: 'Challenge' } as const;

const STATUS_TEXT: Record<Exclude<StepStatus, 'todo'>, string> = {
  done: 'Done',
  started: 'In progress',
};

export function LearningPath({
  open,
  onClose,
  presets,
  challenges,
  explored,
  badgeOf,
  activePresetId,
  activeChallengeId,
  onLoadExample,
  onStartChallenge,
}: LearningPathProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  /* Focus lands on the step to do next, so Enter carries on from where the
     student left off. Focus goes back to whatever opened the dialog. */
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    (nextRef.current ?? card)?.focus();
    return () => {
      const active = document.activeElement;
      const inside = card?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) opener?.focus();
    };
  }, [open]);

  if (!mounted) return null;

  const badge = badgeById(challenges, badgeOf);
  const presetById = new Map(presets.map((p) => [p.id, p]));
  const challengeById = new Map(challenges.map((c) => [c.id, c]));
  const next = nextStep(explored, badge);
  /* Numbered through the whole path, not per track, so "step 12" means one
     place. */
  const numberOf = new Map<PathStep, number>();
  let done = 0;
  for (const track of LEARNING_PATH) {
    for (const step of track.steps) {
      numberOf.set(step, numberOf.size + 1);
      if (stepStatus(step, explored, badge) === 'done') done += 1;
    }
  }
  const total = numberOf.size;

  const nameOf = (step: PathStep): string =>
    (step.kind === 'example'
      ? presetById.get(step.id)?.name
      : challengeById.get(step.id)?.name) ?? step.id;

  const openStep = (step: PathStep) => {
    if (step.kind === 'challenge') onStartChallenge(step.id);
    else {
      const preset = presetById.get(step.id);
      if (preset) onLoadExample(preset);
    }
    onClose();
  };

  const isOpenNow = (step: PathStep) =>
    step.kind === 'challenge'
      ? step.id === activeChallengeId
      : activeChallengeId === null && step.id === activePresetId;

  return createPortal(
    <div
      className={`ex-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="ex-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="ex-card lp-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lp-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        <header className="ex-head">
          <div>
            <h2 id="lp-title" className="ex-title">
              Learning path
            </h2>
            <p className="ex-sub">
              Every example and challenge in an order that builds up. You have done{' '}
              <span className="lp-num">
                {done} of {total}
              </span>
              .
            </p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="lp-body">
          {next ? (
            <div className="lp-next">
              <p className="label lp-next-label">Up next</p>
              <button
                ref={nextRef}
                type="button"
                className="btn btn-primary lp-next-open"
                onClick={() => (isOpenNow(next) ? onClose() : openStep(next))}
              >
                {/* Already on the canvas: going back to it, not reloading it
                    over whatever the student has done since. */}
                {isOpenNow(next)
                  ? `Back to ${nameOf(next)}`
                  : `${next.kind === 'challenge' ? 'Start' : 'Open'} ${nameOf(next)}`}
              </button>
              <p className="lp-next-learn">{next.learn}</p>
            </div>
          ) : (
            <p className="lp-next lp-all-done">
              You have done every step. Try a challenge again without hints, or build a
              design of your own and break it.
            </p>
          )}
          <p className="lp-rule">
            An example counts as done once you run it at twice its starting load for 10
            seconds. A challenge counts once you pass it.
          </p>

          {LEARNING_PATH.map((track) => {
            const trackDone = track.steps.filter(
              (s) => stepStatus(s, explored, badge) === 'done',
            ).length;
            return (
              <section
                key={track.id}
                className="lp-track"
                aria-labelledby={`lp-track-${track.id}`}
              >
                <div className="lp-track-head">
                  <h3 id={`lp-track-${track.id}`} className="lp-track-title">
                    {track.title}
                  </h3>
                  <span className="lp-num lp-track-count">
                    {trackDone} of {track.steps.length} done
                  </span>
                </div>
                <p className="lp-track-about">{track.about}</p>
                <ol className="lp-steps">
                  {track.steps.map((step) => {
                    const status = stepStatus(step, explored, badge);
                    const isNext = step === next;
                    const now = isOpenNow(step);
                    return (
                      <li key={step.id}>
                        <button
                          type="button"
                          className="lp-step"
                          data-status={status}
                          data-next={isNext || undefined}
                          aria-current={now ? 'true' : undefined}
                          onClick={() => openStep(step)}
                        >
                          <span className="lp-mark" aria-hidden="true">
                            {status === 'done' ? (
                              <Check size={14} strokeWidth={2.25} />
                            ) : (
                              numberOf.get(step)
                            )}
                          </span>
                          <span className="lp-step-text">
                            <span className="lp-step-name">
                              {nameOf(step)}
                              <span className="lp-kind">{KIND_TEXT[step.kind]}</span>
                            </span>
                            <span className="lp-step-learn">{step.learn}</span>
                          </span>
                          <span className="lp-status">
                            {status === 'done'
                              ? STATUS_TEXT.done
                              : now
                                ? 'Open now'
                                : status === 'started'
                                  ? STATUS_TEXT.started
                                  : isNext
                                    ? 'Up next'
                                    : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
