import { Fragment, useCallback, useEffect, useId, useRef } from 'react';
import { usePresence } from './presence';
import './MainMenu.css';

/* ==========================================================================
   The main menu.

   WHY IT EXISTS. Examples, Shortcuts, Settings and Glossary were four
   buttons competing for the top bar with the load control and the live
   metrics. They are all the same KIND of thing: reference and setup, reached
   between actions rather than during one. Folding them behind a single
   button leaves the bar carrying only what changes while the simulation
   runs, which is what a reader is actually watching.

   A menu, not a dialog: it opens beside its button, closes on the next click
   anywhere, and never covers the canvas. A dialog would be the wrong weight
   for "show me the shortcuts".
   ========================================================================== */

export interface MenuItem {
  label: string;
  /** Path data for a 24-box stroked icon, matching the rest of the app. */
  icon: string;
  /** Printed on the right, so a binding is learnable from the menu itself. */
  hint?: string;
  onSelect: () => void;
  /** Draws a rule after this row, closing a group. */
  divider?: boolean;
}

export interface MainMenuProps {
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
}

export function MainMenu({ open, onClose, items }: MainMenuProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const listRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  /*
   * Close on a press anywhere else, and on Escape.
   *
   * Pointerdown rather than click, so the menu is gone before whatever was
   * pressed reacts; a canvas gesture starting under an open menu that only
   * closes on click would run with the menu still painted over it.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = listRef.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      // A press on the button that OPENED this menu is left alone, so its
      // own onClick can toggle. Without this the two fight: the outside
      // handler closes on pointerdown and the click reopens a moment later,
      // and the menu appears stuck open.
      if (e.target instanceof Element && e.target.closest('[aria-haspopup="menu"]')) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Deferred a frame: the pointerdown that OPENED the menu would otherwise
    // be the one that closes it.
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  /* Focus the first item on open and return focus to the opener on close,
     the same contract the dialogs keep. */
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Captured now, not read in the cleanup: by the time cleanup runs the ref
    // may already point somewhere else, or nowhere.
    const list = listRef.current;
    list?.querySelector('button')?.focus();
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || list?.contains(active)) {
        opener?.focus();
      }
    };
  }, [open]);

  /** Arrow keys walk the list, which is what a menu role promises. */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(
      listRef.current?.querySelectorAll('button') ?? [],
    ) as HTMLButtonElement[];
    if (buttons.length === 0) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? buttons[(i + 1 + buttons.length) % buttons.length]
        : buttons[(i - 1 + buttons.length) % buttons.length];
    next?.focus();
  }, []);

  if (!mounted) return null;

  return (
    <div
      ref={listRef}
      className={`mn${closing ? ' is-closing' : ''}`}
      role="menu"
      aria-labelledby={id}
      onKeyDown={onKeyDown}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) unmount();
      }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          <button
            type="button"
            role="menuitem"
            className="mn-item"
            onClick={() => {
              // Closed BEFORE the action runs, so a panel the action opens is
              // not competing with a menu still on screen.
              onClose();
              item.onSelect();
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={item.icon} />
            </svg>
            <span className="mn-label">{item.label}</span>
            {item.hint && (
              <kbd className="mn-hint" aria-hidden="true">
                {item.hint}
              </kbd>
            )}
          </button>
          {item.divider && <div className="mn-sep" role="separator" />}
        </Fragment>
      ))}
    </div>
  );
}
