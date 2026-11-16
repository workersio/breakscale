import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CATEGORY_LABEL,
  GLOSSARY,
  GLOSSARY_BY_ID,
  searchGlossary,
  type GlossaryCategory,
  type GlossaryEntry,
} from '../content/glossary';
import { closeTooltip } from './Tooltip';
import { usePresence } from './presence';
import { isCoarsePointer } from '../useCoarsePointer';
import './Glossary.css';

/* ==========================================================================
   The glossary panel.

   WHY THIS EXISTS ALONGSIDE THE TOOLTIPS.

   Hover explanations answer "what is this thing I am looking at". They cannot
   answer "what was that word the lecturer used" — you cannot hover a term you
   have not found. They also do not exist at all on a touch screen until you
   happen to tap the right span. So the same 42 explanations are also
   browsable, searchable and linkable here. One source of truth, two ways in.

   WHY A SIDE SHEET AND NOT A MODAL.

   A modal is the obvious reflex and it is the wrong shape for this app. A
   student opens the glossary while a simulation is running, precisely because
   a number on screen confused them. A centred dialog would cover the canvas
   and the metrics strip — the very things that give "utilisation" a meaning
   they can see. Reading "waiting time rises sharply past 70%" is worth far
   more with the meter still visible beside it.

   So the sheet takes the right-hand edge, over the inspector rail, which is
   the least costly region to lose: it configures one selected node, while the
   canvas and the charts carry the system-wide picture. The canvas stays
   visible and live the whole time it is open.

   It is still a dialog in every other respect — focus is trapped, Escape
   closes, focus returns to whatever opened it — because it is a temporary
   surface the student must be able to leave without hunting for the way out.

   The scrim is deliberately light. It marks the sheet as the active layer
   without hiding the simulation behind it.

   THE PAGE NEVER SCROLLS. The sheet is fixed to the viewport and its result
   list is the only thing that scrolls, inside itself.
   ========================================================================== */

/** Order the category sections appear in. Units first: they are the smallest
 *  ideas and everything else is described using them. */
const CATEGORY_ORDER: GlossaryCategory[] = [
  'unit',
  'latency',
  'throughput',
  'capacity',
  'failure',
  'component',
];

export interface GlossaryProps {
  open: boolean;
  /** Called on Escape, scrim click, or the close button. */
  onClose: () => void;
  /**
   * Scroll to and highlight this entry on open. This is where a tooltip's
   * "see also" link lands, and where the shell should send a student who
   * asked about a specific term.
   */
  focusId?: string;
}

interface Section {
  category: GlossaryCategory;
  entries: GlossaryEntry[];
}

/** Groups a flat result list into category sections, preserving rank order. */
function group(entries: GlossaryEntry[]): Section[] {
  const byCategory = new Map<GlossaryCategory, GlossaryEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category);
    if (list) list.push(e);
    else byCategory.set(e.category, [e]);
  }
  const out: Section[] = [];
  for (const category of CATEGORY_ORDER) {
    const list = byCategory.get(category);
    if (list && list.length > 0) out.push({ category, entries: list });
  }
  return out;
}

/**
 * A searchable reference for every term the interface uses.
 *
 * Renders nothing at all when shut, so it costs one boolean check while the
 * simulation is running.
 */
export function Glossary({ open, onClose, focusId }: GlossaryProps) {
  /**
   * Exit presence. The sheet stays in the DOM while it slides out (the exit
   * animation lives in Glossary.css), marked inert so the leaving panel can
   * neither take focus nor be read by a screen reader, and unmounts on the
   * sheet's animationend. Focus is returned to the opener at close START
   * (the `open` effect below), not at unmount, so the student's focus never
   * sits inside an inert subtree.
   */
  const { mounted, closing, unmount } = usePresence(open);

  const [query, setQuery] = useState('');
  /** The entry the arrow keys are currently on. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** The entry that was jumped to, briefly emphasised so the eye finds it. */
  const [landedId, setLandedId] = useState<string | null>(null);

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Whatever had focus before the sheet opened, so it can be given back. */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const results = useMemo(() => searchGlossary(query), [query]);
  const sections = useMemo(() => group(results), [results]);
  /** Flat, in the order the sections actually render, for arrow navigation. */
  const ordered = useMemo(() => sections.flatMap((s) => s.entries), [sections]);

  /* ---------------------------------------------------------------- *
   * Jumping to an entry
   * ---------------------------------------------------------------- */

  /**
   * Reveals an entry: clears any filter hiding it, moves the selection to it,
   * scrolls it into view and marks it as landed.
   *
   * Clearing the query matters. A cross-reference from "p99" to "utilisation"
   * is useless if the search box still says "p99" and filters the target out
   * of the list the moment it is asked for.
   */
  const jumpTo = useCallback((id: string) => {
    if (!GLOSSARY_BY_ID.has(id)) return;
    setQuery('');
    setActiveId(id);
    setLandedId(id);
  }, []);

  /* Scroll the active entry into view whenever it changes. Layout has already
     been committed by the time an effect runs, so the node is measurable. */
  useEffect(() => {
    if (!open || !activeId) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-entry="${CSS.escape(activeId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
  }, [open, activeId, ordered]);

  /* The landed emphasis is a one-shot cue, not a persistent state. It fades
     on its own so the panel does not keep shouting about a term the student
     has already read. */
  useEffect(() => {
    if (!landedId) return;
    const t = window.setTimeout(() => setLandedId(null), 1600);
    return () => window.clearTimeout(t);
  }, [landedId]);

  /* ---------------------------------------------------------------- *
   * Open / close lifecycle
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!open) return;

    // A tooltip floating over the sheet that just covered its trigger would
    // be orphaned chrome. This is also the path taken when a "see also" link
    // opens the panel.
    closeTooltip();

    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnFocusRef.current = opener;

    // Focus the search box: the panel's primary job is lookup, and a student
    // who opened it almost always arrived with a word in mind.
    // Not on a touch screen, where it raises the keyboard over the list.
    if (isCoarsePointer()) sheetRef.current?.focus();
    else searchRef.current?.focus();

    /* Captured into locals for the cleanup rather than read off the refs when
       it runs. By then the sheet has unmounted and sheetRef.current is null,
       so reading it there would silently skip the focus restore. */
    const sheet = sheetRef.current;

    return () => {
      // Only restore focus if it is still inside the sheet, or nowhere in
      // particular. If the student has clicked away in the meantime, yanking
      // focus back would be rude.
      const active = document.activeElement;
      const inside = sheet?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) {
        opener?.focus();
      }
      returnFocusRef.current = null;
    };
  }, [open]);

  /* Reset between visits, so reopening does not resume a stale search. This
     runs on the way IN rather than at close: the sheet stays mounted while
     it slides out, and clearing the query at close START would visibly blank
     the filtered list mid-exit. Clearing at open is invisible (the sheet is
     only just appearing) and also covers a reopen that interrupts the exit.
     Declared BEFORE the focusId effect below, so on a shared open transition
     the reset runs first and cannot wipe the jump target. */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveId(null);
    setLandedId(null);
  }, [open]);

  /* Opening with a target, or being handed a new one while already open. */
  useEffect(() => {
    if (!open || !focusId) return;
    jumpTo(focusId);
  }, [open, focusId, jumpTo]);

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  /**
   * Moves the selection by `delta` entries, clamped at both ends rather than
   * wrapping. Wrapping in a long list disorients more than it helps: an arrow
   * press that jumps from the bottom back to the top reads as a glitch.
   */
  const move = useCallback(
    (delta: number) => {
      if (ordered.length === 0) return;
      const at = activeId ? ordered.findIndex((e) => e.id === activeId) : -1;
      const next =
        at < 0
          ? delta > 0
            ? 0
            : ordered.length - 1
          : Math.min(Math.max(at + delta, 0), ordered.length - 1);
      setActiveId(ordered[next]?.id ?? null);
    },
    [ordered, activeId],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        case 'ArrowDown':
          e.preventDefault();
          move(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          move(-1);
          return;
        case 'Home':
          // Only when the caret is not in the search box, where Home means
          // "start of the text I am typing".
          if (e.target === searchRef.current) return;
          e.preventDefault();
          setActiveId(ordered[0]?.id ?? null);
          return;
        case 'End':
          if (e.target === searchRef.current) return;
          e.preventDefault();
          setActiveId(ordered[ordered.length - 1]?.id ?? null);
          return;
        case 'Enter': {
          // Enter from the search box commits to the top hit, which is what
          // makes typing "p99" then Enter do the obvious thing.
          if (e.target === searchRef.current) {
            const first = ordered[0];
            if (!first) return;
            e.preventDefault();
            jumpTo(first.id);
          }
          return;
        }
        case 'Tab': {
          /* Focus trap. A dialog that lets Tab escape into the page behind it
             strands a keyboard user somewhere they cannot see. Computed live
             rather than cached, because the list changes as you type. */
          const sheet = sheetRef.current;
          if (!sheet) return;
          const focusables = sheet.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (!first || !last) return;
          const active = document.activeElement;
          if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
          return;
        }
        default:
          return;
      }
    },
    [move, onClose, ordered, jumpTo],
  );

  if (!mounted) return null;

  const total = GLOSSARY.length;
  const shown = results.length;

  return createPortal(
    <div
      className={`gl-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      {/*
        The scrim marks the sheet as the active layer and gives the pointer a
        large, obvious way out. It is not a focus boundary — the Tab handler
        above is — and it is not announced, because it carries no information.
      */}
      <div className="gl-scrim" onClick={onClose} aria-hidden="true" />

      <div
        ref={sheetRef}
        className="gl-sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gl-title"
        onKeyDown={onKeyDown}
        onAnimationEnd={(e) => {
          // The SHEET drives unmount, not the scrim: both animate on close,
          // and unmounting on whichever ended first would cut the other off.
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        <header className="gl-head">
          <div className="gl-head-row">
            <h2 id="gl-title" className="gl-title">
              Glossary
            </h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              onClick={onClose}
              aria-label="Close glossary"
            >
              <svg
                width="16"
                height="16"
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
          </div>

          <p className="gl-sub">
            Every term this app puts on screen, and why it matters.
          </p>

          <div className="gl-search">
            <svg
              className="gl-search-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              className="gl-search-input"
              placeholder="Search terms"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // The old selection is probably filtered out now; leaving it
                // set would make the next arrow press jump somewhere random.
                setActiveId(null);
              }}
              /* A search field, not a combobox: results are a document that
                 stays on screen, not a transient popup listbox. */
              aria-label="Search glossary terms"
              aria-describedby="gl-count"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="gl-search-clear"
                onClick={() => {
                  setQuery('');
                  setActiveId(null);
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
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
            ) : null}
          </div>

          {/*
            aria-live so a screen reader hears the result count change as the
            query is typed. Polite, so it waits for a pause in typing rather
            than interrupting every keystroke.
          */}
          <p id="gl-count" className="gl-count" aria-live="polite">
            {query
              ? `${shown} of ${total} ${shown === 1 ? 'term' : 'terms'}`
              : `${total} terms`}
          </p>
        </header>

        <div ref={listRef} className="gl-list scroll">
          {shown === 0 ? (
            <div className="empty">
              <p>No term matches “{query}”.</p>
              <p>Try a shorter word, or clear the search to browse them all.</p>
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.category} className="gl-section">
                <h3 className="label gl-section-title">
                  {CATEGORY_LABEL[section.category]}
                </h3>
                <ul className="gl-entries">
                  {section.entries.map((entry) => (
                    <Entry
                      key={entry.id}
                      entry={entry}
                      active={entry.id === activeId}
                      landed={entry.id === landedId}
                      onSelect={setActiveId}
                      onNavigate={jumpTo}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ *
 * One entry
 * ------------------------------------------------------------------ */

interface EntryProps {
  entry: GlossaryEntry;
  active: boolean;
  landed: boolean;
  onSelect: (id: string) => void;
  onNavigate: (id: string) => void;
}

function Entry({ entry, active, landed, onSelect, onNavigate }: EntryProps) {
  const see = (entry.see ?? [])
    .map((id) => GLOSSARY_BY_ID.get(id))
    .filter((e): e is GlossaryEntry => e !== undefined);

  return (
    <li
      data-entry={entry.id}
      className={`gl-entry${active ? ' is-active' : ''}${landed ? ' is-landed' : ''}`}
      /* Clicking anywhere in the entry selects it, so the arrow keys resume
         from where the eye already is. */
      onClick={() => onSelect(entry.id)}
    >
      <h4 className="gl-term">{entry.term}</h4>
      <p className="gl-short">{entry.short}</p>
      <p className="gl-why">{entry.why}</p>

      {see.length > 0 ? (
        <p className="gl-see">
          <span className="gl-see-label">See also</span>
          {see.map((other) => (
            <button
              key={other.id}
              type="button"
              className="gl-see-link"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(other.id);
              }}
            >
              {other.term}
            </button>
          ))}
        </p>
      ) : null}
    </li>
  );
}
