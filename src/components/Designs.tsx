import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import {
  MAX_NAME,
  MAX_SAVED,
  deleteDesign,
  listDesigns,
  renameDesign,
  savedAgo,
} from '../savedDesigns';
import type { SavedSummary } from '../savedDesigns';
import './Designs.css';

/* ==========================================================================
   Your designs.

   WHY IT EXISTS. The session autosaves, so work survives a reload, and a
   file export keeps a design forever. Neither lets a student hold two ideas
   at once, which is exactly what they do: build something, wonder what a
   cache would change, and want both afterwards.

   A dialog rather than a rail: this is consulted between actions, like the
   examples gallery it sits beside in the menu, and it should not take
   permanent room from the canvas to do it.
   ========================================================================== */

export interface DesignsProps {
  open: boolean;
  onClose: () => void;
  /** Load a saved design onto the canvas. */
  onOpen: (id: string) => void;
  /** Save what is on the canvas now, under this name. */
  onSave: (name: string) => void;
  /** Suggested name for a new save, usually the loaded example's. */
  suggestedName?: string;
  /** False while the canvas has nothing on it: an empty save is a blank row. */
  canSave?: boolean;
  /** Open a design file. Omitted, the button is not shown. */
  onOpenFile?: () => void;
}

export function Designs({
  open,
  onClose,
  onOpen,
  onSave,
  suggestedName = '',
  canSave = true,
  onOpenFile,
}: DesignsProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<SavedSummary[]>([]);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Read the shelf on open, not on mount: another tab may have saved
     something since, and this is the moment the reader is looking. */
  const refresh = useCallback(() => setItems(listDesigns()), []);
  useEffect(() => {
    if (!open) return;
    refresh();
    setName(suggestedName);
    setError(null);
    setRenaming(null);
  }, [open, refresh, suggestedName]);

  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    card?.focus();
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || card?.contains(active)) {
        opener?.focus();
      }
    };
  }, [open]);

  const doSave = useCallback(() => {
    if (!canSave) return;
    const clean = name.trim();
    if (!clean) {
      setError('Give the design a name first.');
      return;
    }
    onSave(clean);
    setError(null);
    // Deferred a tick so the shell's write has landed before it is read
    // back; reading synchronously would show the list as it was.
    setTimeout(refresh, 0);
  }, [canSave, name, onSave, refresh]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`dz-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="dz-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="dz-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dz-title"
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
        <header className="dz-head">
          <h2 id="dz-title" className="dz-title">
            Your designs
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={onClose}
            aria-label="Close your designs"
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

        <div className="dz-save">
          <input
            className="dz-name"
            type="text"
            value={name}
            maxLength={MAX_NAME}
            placeholder="Name this design"
            aria-label="Design name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                doSave();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={doSave}
            // aria-disabled, not disabled: the button keeps its focus stop, so
            // a keyboard or screen reader user still hears the hint. doSave
            // ignores the press.
            aria-disabled={canSave ? undefined : true}
            aria-describedby={canSave ? undefined : 'dz-save-hint'}
          >
            Save
          </button>
          {onOpenFile && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                // The picker opens first, while the press still counts as a
                // user gesture; closing the dialog cannot take that away.
                onOpenFile();
                onClose();
              }}
            >
              Open a file
            </button>
          )}
        </div>
        {!canSave && (
          <p id="dz-save-hint" className="dz-hint">
            Add something to the canvas first.
          </p>
        )}

        {error && (
          <p className="dz-error" role="alert">
            {error}
          </p>
        )}

        <div className="dz-body">
          {items.length === 0 ? (
            <p className="dz-empty">
              Nothing saved yet. Name what is on the canvas and press Save, and it will
              wait here for you.
            </p>
          ) : (
            <ul className="dz-list">
              {items.map((d) => (
                <li key={d.id} className="dz-item">
                  {renaming === d.id ? (
                    <input
                      className="dz-name dz-rename"
                      type="text"
                      defaultValue={d.name}
                      maxLength={MAX_NAME}
                      aria-label={`Rename ${d.name}`}
                      autoFocus
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setRenaming(null);
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          if (!renameDesign(d.id, e.currentTarget.value)) {
                            setError('That name is already taken.');
                          } else {
                            setError(null);
                          }
                          setRenaming(null);
                          refresh();
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="dz-open"
                      onClick={() => {
                        onOpen(d.id);
                        onClose();
                      }}
                    >
                      <span className="dz-item-name">{d.name}</span>
                      <span className="dz-item-meta">
                        {d.nodeCount} component{d.nodeCount === 1 ? '' : 's'} ·{' '}
                        {savedAgo(d.savedAt)}
                      </span>
                    </button>
                  )}

                  <div className="dz-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setRenaming(d.id)}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm dz-delete"
                      onClick={() => {
                        deleteDesign(d.id);
                        refresh();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="dz-foot">
          {/* Said plainly, because "saved" invites the assumption that it
              went somewhere. Nothing here leaves the machine, so clearing
              site data takes these with it and another browser will not see
              them. A file is the way to move one. */}
          Saved in this browser only, on this computer. Nothing is uploaded. Clearing
          your browser data will remove them. {items.length} of {MAX_SAVED} used. To
          keep a design somewhere safer, or open it elsewhere, save it to a file from
          Settings.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
