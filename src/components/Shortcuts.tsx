import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import './Shortcuts.css';

/* ==========================================================================
   The keyboard shortcuts dialog.

   WHY IT EXISTS. The app now carries more than twenty bindings, and a
   binding nobody can discover is a binding that does not exist. The glossary
   answers "what does this word mean"; this answers "what can my hands do".

   WHY A CENTRED DIALOG WHERE THE GLOSSARY IS A SIDE SHEET. The glossary is
   read WHILE watching the simulation, so it must leave the canvas visible.
   This is a reference card consulted between actions, not during one; it is
   glanced at, closed, and acted on. A compact centred card is the honest
   shape for that, and it never needs to coexist with a live reading.

   GROUPED BY WHAT THEY DO, not alphabetically: a student arrives asking
   "how do I zoom", never "what does Z do". Each group is one task.

   WHY Ctrl+/ AND A BUTTON, NOT "?". The "?" key already toggles the
   glossary and has since it shipped; stealing it would break a taught
   habit. Ctrl+/ is the other settled convention for exactly this dialog
   (the key that types "?" without its shift), and the labelled button in
   the top bar makes the dialog findable by someone who knows no shortcuts
   at all, which is precisely the audience it serves.
   ========================================================================== */

interface Row {
  /** Chords, each rendered as one key cap; alternatives joined with "or". */
  keys: string[];
  does: string;
}

interface Group {
  title: string;
  rows: Row[];
}

const GROUPS: Group[] = [
  {
    title: 'Simulation',
    rows: [
      { keys: ['Space'], does: 'Play or pause' },
      { keys: ['S'], does: 'Step one tick (pauses first)' },
      { keys: ['F'], does: 'Can you break it?' },
    ],
  },
  {
    title: 'Build',
    rows: [
      { keys: ['Drag a port'], does: 'Connect two components' },
      { keys: ['Click a port'], does: 'Arm a link; click the target to finish' },
      { keys: ['Double-click'], does: 'Rename a component in place' },
      { keys: ['Ctrl+D'], does: 'Duplicate the selection' },
      { keys: ['Alt+drag'], does: 'Drag out a copy' },
      { keys: ['Delete', 'Backspace'], does: 'Delete the selection' },
    ],
  },
  {
    title: 'Clipboard and history',
    rows: [
      { keys: ['Ctrl+C'], does: 'Copy the selection' },
      { keys: ['Ctrl+X'], does: 'Cut the selection' },
      { keys: ['Ctrl+V'], does: 'Paste at the pointer' },
      { keys: ['Ctrl+Z'], does: 'Undo' },
      { keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], does: 'Redo' },
    ],
  },
  {
    title: 'Select and move',
    rows: [
      { keys: ['Shift+click'], does: 'Add to or remove from the selection' },
      { keys: ['Shift+drag'], does: 'Box-select on empty space' },
      { keys: ['Ctrl+A'], does: 'Select everything' },
      { keys: ['Arrows'], does: 'Move the selection one grid step' },
      { keys: ['Shift+Arrows'], does: 'Move by 1px, off the grid' },
      { keys: ['G'], does: 'Snap to the grid, on or off' },
      { keys: ['Ctrl while dragging'], does: 'Bypass the snap for one drag' },
      { keys: ['Esc'], does: 'Cancel the gesture and deselect' },
    ],
  },
  {
    title: 'Notes and sections',
    rows: [
      { keys: ['N'], does: 'Note tool: click the canvas to place text' },
      { keys: ['B'], does: 'Section tool: drag to frame a group' },
      { keys: ['Double-click a note'], does: 'Edit its text in place' },
      { keys: ['Double-click a section'], does: 'Rename its label' },
    ],
  },
  {
    title: 'View',
    rows: [
      { keys: ['Ctrl+=', 'Ctrl+-'], does: 'Zoom in or out' },
      { keys: ['Ctrl+0'], does: 'Zoom to 100%' },
      { keys: ['Shift+1'], does: 'Zoom to fit everything' },
      { keys: ['Shift+2'], does: 'Zoom to the selection' },
      { keys: ['Ctrl+wheel'], does: 'Zoom at the cursor' },
      { keys: ['Space+drag', 'Middle-drag'], does: 'Pan' },
    ],
  },
  {
    title: 'Panels and help',
    rows: [
      { keys: ['C'], does: 'Components rail' },
      { keys: ['M'], does: 'Charts strip' },
      { keys: ['I'], does: 'Inspector, while something is selected' },
      { keys: ['?'], does: 'Glossary' },
      { keys: ['Ctrl+/'], does: 'This dialog' },
    ],
  },
];

export interface ShortcutsProps {
  open: boolean;
  onClose: () => void;
}

export function Shortcuts({ open, onClose }: ShortcutsProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);

  /* Focus lands on the card at open and returns to the opener at close
     start, the same contract the glossary keeps. The card itself is the
     focus target (tabIndex -1): its only control is the close button, and
     landing there first would announce "close" before the title. */
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    card?.focus();
    return () => {
      const active = document.activeElement;
      const inside = card?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) {
        opener?.focus();
      }
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`sc-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="sc-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="sc-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sc-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          /* Focus trap. The dialog holds exactly one focusable control, so
             the trap is simply "Tab goes to it, and from it back". */
          if (e.key === 'Tab') {
            e.preventDefault();
            const btn = cardRef.current?.querySelector<HTMLElement>('button');
            if (document.activeElement === btn) cardRef.current?.focus();
            else btn?.focus();
          }
        }}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        <header className="sc-head">
          <h2 id="sc-title" className="sc-title">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
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
        </header>

        <div className="sc-body">
          {GROUPS.map((g) => (
            <section key={g.title} className="sc-group">
              <h3 className="sc-group-title">{g.title}</h3>
              <dl className="sc-rows">
                {g.rows.map((row) => (
                  <div key={row.does} className="sc-row">
                    <dt className="sc-keys">
                      {row.keys.map((k, i) => (
                        <span key={k} className="sc-alt">
                          {i > 0 && <span className="sc-or">or</span>}
                          <kbd className="sc-kbd">{k}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd className="sc-does">{row.does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
