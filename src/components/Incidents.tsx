import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Incident } from '../sim/incidents';
import './Incidents.css';

/* ==========================================================================
   A real incident, beside the canvas.

   Uses the brief's panel (Challenge.css) for its frame, its place on the
   canvas and its sheet on a phone, as "Can you break it?" does. Watching
   plays the scene on the reader's canvas; fixing it hands over to the
   challenge panel, so the check, the hints and Leave are the ones every
   other brief has.
   ========================================================================== */

export interface IncidentPanelProps {
  incident: Incident;
  /** What is happening in the replay right now, or null when not watching. */
  caption: string | null;
  onWatch: () => void;
  onFix: () => void;
  onClose: () => void;
  /** Bumped when a card is opened, to move focus to the heading. */
  focusSignal: number;
  foldOnStart?: boolean;
  onSheetResize?: (height: number | null, shut: boolean) => void;
}

export function IncidentPanel({
  incident,
  caption,
  onWatch,
  onFix,
  onClose,
  focusSignal,
  foldOnStart = false,
  onSheetResize,
}: IncidentPanelProps) {
  const headingId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(foldOnStart);

  /* Another incident opens unfolded. Adjusted during render, so the old
     state is never painted for a frame. */
  const [seen, setSeen] = useState(incident.id);
  if (seen !== incident.id) {
    setSeen(incident.id);
    setCollapsed(foldOnStart);
  }

  /* Report the sheet's size to the shell, as the brief's panel does. */
  const shutRef = useRef(collapsed);
  const onSheetResizeRef = useRef(onSheetResize);
  useLayoutEffect(() => {
    shutRef.current = collapsed;
    onSheetResizeRef.current = onSheetResize;
  });
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      onSheetResizeRef.current?.(el.getBoundingClientRect().height, shutRef.current);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      onSheetResizeRef.current?.(null, shutRef.current);
    };
  }, []);

  useEffect(() => {
    if (focusSignal > 0) headingRef.current?.focus();
  }, [focusSignal]);

  /* Watch sits at the foot of the panel, so on a phone the sheet is
     scrolled down when it is pressed. Back to the top once the caption is
     in, or the replay plays with its caption out of sight. */
  const toTopRef = useRef(false);
  useLayoutEffect(() => {
    if (!toTopRef.current || caption === null) return;
    toTopRef.current = false;
    if (sectionRef.current) sectionRef.current.scrollTop = 0;
  });
  const watch = () => {
    toTopRef.current = true;
    onWatch();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <section
      ref={sectionRef}
      className={`chal inc${collapsed ? ' is-collapsed' : ''}`}
      role="region"
      aria-labelledby={headingId}
      data-chrome=""
      onKeyDown={onKeyDown}
    >
      <header className="chal-head">
        <div className="chal-head-text">
          <p className="label chal-kicker">Real incident, {incident.date}</p>
          <h2 id={headingId} ref={headingRef} className="chal-name" tabIndex={-1}>
            {incident.name}
          </h2>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-icon chal-collapse"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? 'Show the panel' : 'Fold the panel'}
          title={collapsed ? 'Show the panel' : 'Fold the panel'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={collapsed ? 'm6 9 6 6 6-6' : 'm18 15-6-6-6 6'} />
          </svg>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-icon"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      {/* Readable with the panel folded, so the replay can be watched with
          the canvas in view. The live region is always mounted: one that
          appears with its first text is often not announced. */}
      {caption !== null ? (
        <p className="inc-caption" aria-hidden="true">
          {caption}
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {caption ?? ''}
      </p>

      <div id={bodyId} className="chal-body" hidden={collapsed}>
        <p className="inc-model">
          A simplified model. Times and numbers here are from the simulator, not the
          real event. {incident.simNote}
        </p>
        <p className="chal-brief inc-story">{incident.story.join(' ')}</p>
        <p className="inc-source">
          Source:{' '}
          <a href={incident.source.url} target="_blank" rel="noreferrer">
            {incident.source.title}
          </a>
        </p>
        <div className="chal-foot">
          <button type="button" className="btn btn-sm" onClick={watch}>
            {caption !== null ? 'Watch again' : 'Watch it happen'}
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={onFix}>
            Fix it
          </button>
        </div>
      </div>
    </section>
  );
}
