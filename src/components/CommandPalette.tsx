import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { rankCommands, type Command } from '../commands';
import { usePresence } from './presence';
import './CommandPalette.css';

/* ==========================================================================
   The command palette.

   Anything the app can do, found by typing a few letters of it. The rows
   come from appCommands.ts; this file owns the search box, the list and the
   keys. A combobox with a listbox, the pattern a screen reader already
   knows: focus stays in the box while the arrows move an active row, named
   by aria-activedescendant.
   ========================================================================== */

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: readonly Command[];
  /** Ids, newest first. Shown first before anything is typed. */
  recent: readonly string[];
  /** Runs after the palette has closed and focus has gone back. */
  onRun: (cmd: Command) => void;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { mounted, closing, unmount } = usePresence(props.open);
  if (!mounted) return null;
  return createPortal(
    <PaletteCard {...props} closing={closing} unmount={unmount} />,
    document.body,
  );
}

/** A row at or past the end of a page jump. */
const PAGE = 8;

function PaletteCard({
  onClose,
  commands,
  recent,
  onRun,
  closing,
  unmount,
}: CommandPaletteProps & { closing: boolean; unmount: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const base = useId();

  /* The shell stops building the list the moment the palette is asked to
     close, so the rows on screen are held through the exit fade. The
     adjust-during-render pattern, as in presence.ts. */
  const [held, setHeld] = useState(commands);
  if (!closing && held !== commands) setHeld(commands);

  const rows = useMemo(() => rankCommands(held, query, recent), [held, query, recent]);
  const shown = Math.min(active, Math.max(0, rows.length - 1));
  const current = rows[shown];

  /* Focus the box on open and give it back to the opener on close: the
     contract every dialog here keeps. */
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input = inputRef.current;
    input?.focus();
    return () => {
      const a = document.activeElement;
      if (!a || a === document.body || a === input) opener?.focus();
    };
  }, []);

  /* Keep the active row in view. By hand rather than scrollIntoView, which
     also scrolls every scrollable ancestor and once shifted the whole app. */
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = current ? document.getElementById(`${base}-${current.id}`) : null;
    if (!list || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [current, base]);

  const run = (cmd: Command | undefined) => {
    if (!cmd || cmd.disabled) return;
    onClose();
    onRun(cmd);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = rows.length - 1;
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(last, to)));
    };
    if (e.key === 'ArrowDown') move(shown >= last ? 0 : shown + 1);
    else if (e.key === 'ArrowUp') move(shown <= 0 ? last : shown - 1);
    else if (e.key === 'PageDown') move(shown + PAGE);
    else if (e.key === 'PageUp') move(shown - PAGE);
    else if (e.key === 'Enter') {
      e.preventDefault();
      run(current);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      // The box is the only stop; the list is reached with the arrows.
      e.preventDefault();
    }
  };

  return (
    <div
      className={`cp-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
      data-chrome="palette"
    >
      <div className="cp-scrim" onPointerDown={onClose} aria-hidden="true" />
      <div
        className="cp-card"
        role="dialog"
        aria-modal="true"
        aria-label="Search actions"
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        <div className="cp-field">
          <svg
            className="cp-glyph"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            className="cp-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${base}-list`}
            aria-autocomplete="list"
            aria-activedescendant={current ? `${base}-${current.id}` : undefined}
            aria-label="Search actions"
            placeholder="Type an action, a part or an example"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          ref={listRef}
          id={`${base}-list`}
          className="cp-list"
          role="listbox"
          aria-label="Actions"
        >
          {rows.map((c, i) => (
            <div
              key={c.id}
              id={`${base}-${c.id}`}
              className={`cp-row${i === shown ? ' is-active' : ''}`}
              role="option"
              aria-selected={i === shown}
              aria-disabled={c.disabled ? true : undefined}
              onPointerMove={() => {
                if (i !== shown) setActive(i);
              }}
              /* Pointerdown would steal focus from the box before the click
                 lands; the box keeps it, so typing carries on. */
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => run(c)}
            >
              <span className="cp-text">
                <span className="cp-label">{c.label}</span>
                {c.disabled ? <span className="cp-why">{c.disabled}</span> : null}
              </span>
              <span className="cp-group">{c.group}</span>
              {c.hint ? <kbd className="cp-kbd">{c.hint}</kbd> : null}
            </div>
          ))}
          {rows.length === 0 ? (
            <p className="cp-none">Nothing matches that. Try fewer letters.</p>
          ) : null}
        </div>
        <p className="cp-status" role="status">
          {query.trim() === ''
            ? ''
            : rows.length === 0
              ? 'No matches'
              : `${rows.length} ${rows.length === 1 ? 'match' : 'matches'}`}
        </p>
      </div>
    </div>
  );
}
