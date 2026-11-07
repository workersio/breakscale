import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Challenge } from '../sim/challenge';
import type { ChallengeBadge } from '../challengeWorkspace';
import { inPickerOrder } from '../challengeWorkspace';
import { usePresence } from './presence';
import './Examples.css';
import './Challenge.css';

/* ==========================================================================
   The challenge picker.

   Deliberately the examples dialog's shell and stylesheet rather than a third
   dialog design. A reader who has opened Examples already knows how this
   behaves, and the two are the same act: pick a system to load. What differs
   is that these arrive with a goal attached.

   No search box. There are four of these against twenty-three examples, and
   a filter over four rows is furniture.

   Each brief says where the reader stands with it: passed, or started and
   not finished, which is the one that picking resumes rather than starts.
   Grouped by level, easiest first, once there is more than one level to
   group by; a single heading over every card would say nothing.
   ========================================================================== */

export interface ChallengesProps {
  open: boolean;
  onClose: () => void;
  challenges: readonly Challenge[];
  onStart: (id: string) => void;
  badgeOf: (challenge: Challenge) => ChallengeBadge;
}

const BADGE_TEXT: Record<Exclude<ChallengeBadge, null>, string> = {
  passed: 'Passed',
  'in-progress': 'In progress',
};

export function Challenges({
  open,
  onClose,
  challenges,
  onStart,
  badgeOf,
}: ChallengesProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  if (!mounted) return null;

  const groups: [number, Challenge[]][] = [];
  for (const c of inPickerOrder(challenges)) {
    const tier = c.tier ?? 1;
    const last = groups[groups.length - 1];
    if (last && last[0] === tier) last[1].push(c);
    else groups.push([tier, [c]]);
  }

  return createPortal(
    <div
      className={`ex-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="ex-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="ex-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chal-title"
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
            <h2 id="chal-title" className="ex-title">
              Challenges
            </h2>
            <p className="ex-sub">
              A system that does not meet its requirement. Work out why, and fix it.
            </p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="chal-picker">
          {groups.map(([tier, list]) => (
            <section
              key={tier}
              className="chal-tier"
              aria-labelledby={groups.length > 1 ? `chal-tier-${tier}` : undefined}
            >
              {groups.length > 1 ? (
                <h3 id={`chal-tier-${tier}`} className="label chal-tier-title">
                  Level {tier}
                </h3>
              ) : null}
              <ul className="ex-grid">
                {list.map((c) => {
                  const badge = badgeOf(c);
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="ex-item"
                        onClick={() => {
                          onStart(c.id);
                          onClose();
                        }}
                      >
                        <span className="ex-item-name">{c.name}</span>
                        <span className="ex-item-desc">{c.brief}</span>
                        {badge ? (
                          <span className={`ex-item-active chal-badge is-${badge}`}>
                            {BADGE_TEXT[badge]}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
