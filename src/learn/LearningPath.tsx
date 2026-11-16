import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { Challenge } from '../sim/challenge';
import type { Preset } from '../sim/presets';
import type { ChallengeBadge } from '../challengeWorkspace';
import { LEARNING_PATH, type PathStep } from '../content/learningPath';
import { usePresence } from '../components/presence';
import { badgeById, briefIdOf, nextStep, stepName, stepStatus } from './pathProgress';
import '../components/Examples.css';
import './LearningPath.css';
import { CloseButton } from '../components/CloseButton';

/* ==========================================================================
   The learning path dialog.

   The examples dialog's shell, because opening a step is the same act as
   picking an example or a brief, and it goes through the same handlers, so
   loading one over the student's design keeps the same undo. What it adds
   is an order and a record: the step to do next, and how far through each
   track the student is.

   A list, not a grid of cards. A path is read top to bottom, and numbered
   rows say that where a grid would not.

   Each row says where it stands with a badge that is only a word, and acts
   through one real button beside it, so nothing that looks pressable is
   only a status. The step already on the canvas is continued, not loaded
   again over whatever the student has done to it since.

   A real outage opens its story first, as the examples dialog does, with
   Watch it happen to press first. Its Fix it is a brief like any other,
   and the pass of that brief is what marks the step done.
   ========================================================================== */

export interface LearningPathProps {
  open: boolean;
  onClose: () => void;
  presets: readonly Preset[];
  /** Every brief the path can judge by, the outages' own included. */
  challenges: readonly Challenge[];
  explored: ReadonlySet<string>;
  badgeOf: (challenge: Challenge) => ChallengeBadge;
  activePresetId: string | null;
  activeChallengeId: string | null;
  /** The outage whose story panel is open, or null. */
  activeIncidentId: string | null;
  onLoadExample: (preset: Preset) => void;
  onStartChallenge: (id: string) => void;
  onOpenIncident: (id: string) => void;
}

const KIND_TEXT = {
  example: 'Example',
  challenge: 'Challenge',
  incident: 'Real outage',
} as const;

/**
 * What a step's button does, said as its label.
 *
 * - `Continue`: the step is on the canvas, or a brief with an attempt saved,
 *   and it carries on from there.
 * - `Again`: an example already done, loaded fresh, or an outage already
 *   fixed, with its story open to watch again.
 * - `Open`: a brief already passed. Its saved attempt is the passing design,
 *   so it opens that, and the brief's own Start over gives a fresh one.
 * - `Start`: anything else.
 */
type Verb = 'Start' | 'Continue' | 'Again' | 'Open';

/** The row button's name, read as a sentence: "Do step 1 again, Single server". */
function labelOf(verb: Verb, n: number | undefined, name: string): string {
  switch (verb) {
    case 'Again':
      return `Do step ${n} again, ${name}`;
    case 'Open':
      return `Open step ${n}, ${name}, passed`;
    default:
      return `${verb} step ${n}, ${name}`;
  }
}

export function LearningPath({
  open,
  onClose,
  presets,
  challenges,
  explored,
  badgeOf,
  activePresetId,
  activeChallengeId,
  activeIncidentId,
  onLoadExample,
  onStartChallenge,
  onOpenIncident,
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

  const nameOf = stepName;

  const isOpenNow = (step: PathStep) => {
    /* An outage's story over the canvas is what the student sees, so the
       example under it is not the one open. */
    if (step.kind === 'example') {
      return (
        activeChallengeId === null &&
        activeIncidentId === null &&
        step.id === activePresetId
      );
    }
    if (step.kind === 'incident' && step.id === activeIncidentId) return true;
    return briefIdOf(step) === activeChallengeId;
  };

  /* A brief on the canvas still goes through the start handler: it does not
     reload one already live, it only brings its panel forward. An example on
     the canvas is left exactly as it is. */
  const openStep = (step: PathStep) => {
    if (step.kind === 'challenge') onStartChallenge(step.id);
    else if (step.kind === 'incident') {
      /* The story first, unless the student is already fixing it or has
         an attempt saved: then the brief, where that attempt is. */
      const brief = briefIdOf(step);
      const status = stepStatus(step, explored, badge);
      if (brief !== null && (brief === activeChallengeId || status === 'started')) {
        onStartChallenge(brief);
      } else onOpenIncident(step.id);
    } else if (!isOpenNow(step)) {
      const preset = presetById.get(step.id);
      if (preset) onLoadExample(preset);
    }
    onClose();
  };

  const verbOf = (step: PathStep): Verb => {
    if (isOpenNow(step)) return 'Continue';
    const status = stepStatus(step, explored, badge);
    if (status === 'done') return step.kind === 'challenge' ? 'Open' : 'Again';
    return status === 'started' ? 'Continue' : 'Start';
  };

  /** How the step counts as done, in the words the rule is kept in. */
  const ruleOf = (step: PathStep): string => {
    switch (step.kind) {
      case 'challenge':
        return 'It counts as done once you pass it.';
      case 'incident':
        return 'Watch it happen, then fix it. It counts as done once your fix passes.';
      case 'example':
        return 'A short task opens with it. It counts as done once you finish the task.';
    }
  };

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
              Every example, challenge and real outage, in an order that builds up.
            </p>
            <p className="lp-progress">
              {done} of {total} done
            </p>
            <p className="lp-rules">
              An example is done when you finish its task. A challenge or an outage is
              done when your design passes.
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </header>

        <div className="lp-body">
          {next ? (
            <div className="lp-next">
              <p className="label lp-next-label">Up next</p>
              <p className="lp-next-name">
                {nameOf(next)}
                <span className="lp-kind">{KIND_TEXT[next.kind]}</span>
              </p>
              <p className="lp-next-learn">{next.learn}</p>
              <p className="lp-next-rule">{ruleOf(next)}</p>
              <div className="lp-next-act">
                <button
                  ref={nextRef}
                  type="button"
                  className="btn btn-primary lp-next-open"
                  onClick={() => openStep(next)}
                >
                  {verbOf(next)} {nameOf(next)}
                </button>
                {isOpenNow(next) ? (
                  <span className="lp-next-where">It is open behind this dialog.</span>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="lp-next lp-all-done">
              You have done every step. Try a challenge again without hints, or build a
              design of your own and break it.
            </p>
          )}

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
                    const now = isOpenNow(step);
                    const n = numberOf.get(step);
                    const verb = verbOf(step);
                    /* One word at most. The one on the canvas says so before
                       saying it is done, since that is what Continue acts on;
                       the check mark still says done. */
                    const badgeText = now
                      ? 'Current'
                      : status === 'done'
                        ? 'Done'
                        : status === 'started'
                          ? 'In progress'
                          : null;
                    return (
                      <li
                        key={step.id}
                        className="lp-step"
                        data-status={status}
                        data-next={step === next || undefined}
                        aria-current={now ? 'step' : undefined}
                      >
                        <span className="lp-mark" aria-hidden="true">
                          {status === 'done' ? <Check size={14} strokeWidth={2} /> : n}
                        </span>
                        <span className="lp-step-text">
                          <span className="lp-step-name">
                            <span className="lp-step-title">{nameOf(step)}</span>
                            <span className="lp-kind">{KIND_TEXT[step.kind]}</span>
                            {badgeText ? (
                              <span
                                className="lp-badge"
                                data-badge={now ? 'current' : status}
                              >
                                {badgeText}
                              </span>
                            ) : null}
                          </span>
                          <span className="lp-step-learn">{step.learn}</span>
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm lp-step-go"
                          aria-label={labelOf(verb, n, nameOf(step))}
                          onClick={() => openStep(step)}
                        >
                          {verb}
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
