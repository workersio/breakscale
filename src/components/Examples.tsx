import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Preset } from '../sim/presets';
import { usePresence } from './presence';
import './Examples.css';

/* ==========================================================================
   The examples gallery.

   These used to be a collapsed section at the bottom of the components rail,
   under thirty-three draggable parts. That was the wrong home for two
   reasons. A rail item is something you drag onto the canvas; an example is a
   whole system you load, which is a different kind of act entirely. And the
   empty-canvas message tells a student to "open Examples", which pointed at
   nothing whenever the rail was collapsed.

   So it is a dialog opened from the top bar, beside the glossary and the
   shortcuts, which is where this app already puts its references. The gallery
   form also earns its place: a row in a rail can show a name and six words,
   while a card can show what the example actually teaches, which is the only
   thing that helps a student choose between twenty-three of them.
   ========================================================================== */

export interface ExamplesProps {
  open: boolean;
  onClose: () => void;
  presets: readonly Preset[];
  activePresetId: string | null;
  onLoad: (preset: Preset) => void;
  /** Opens the learning path, which orders these with the challenges. */
  onOpenPath?: () => void;
}

export function Examples({
  open,
  onClose,
  presets,
  activePresetId,
  onLoad,
  onOpenPath,
}: ExamplesProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');

  /* Reset on OPEN rather than on close, so the list is not blanked out from
     under the reader while the dialog is still sliding away. */
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  /* Focus goes to the search field, because with twenty-three examples the
     first thing a returning student does is type. Focus returns to whatever
     opened the dialog. */
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    searchRef.current?.focus();
    return () => {
      const active = document.activeElement;
      const inside = card?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) {
        opener?.focus();
      }
    };
  }, [open]);

  if (!mounted) return null;

  const q = query.trim().toLowerCase();
  const shown = q
    ? presets.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.tagline.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q),
      )
    : presets;

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
        aria-labelledby="ex-title"
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
            <h2 id="ex-title" className="ex-title">
              Examples
            </h2>
            <p className="ex-sub">
              Load a system that already works, then take it apart.
            </p>
          </div>
          <div className="ex-head-actions">
            {onOpenPath ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onClose();
                  onOpenPath();
                }}
              >
                Learning path
              </button>
            ) : null}
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <input
          ref={searchRef}
          type="text"
          className="ex-search"
          placeholder="Search examples"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search examples"
        />

        {shown.length === 0 ? (
          <p className="ex-empty">
            Nothing matches “{query}”. Try a component name like cache or queue.
          </p>
        ) : (
          <ul className="ex-grid">
            {shown.map((preset) => {
              const active = preset.id === activePresetId;
              return (
                <li key={preset.id}>
                  <button
                    type="button"
                    className="ex-item"
                    data-active={active || undefined}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      onLoad(preset);
                      onClose();
                    }}
                  >
                    <span className="ex-item-name">{preset.name}</span>
                    <span className="ex-item-tagline">{preset.tagline}</span>
                    {/* The full description is what actually helps a student
                        choose, and it is the thing a rail row had no room
                        for. */}
                    <span className="ex-item-desc">{preset.description}</span>
                    {active ? <span className="ex-item-active">Loaded</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
