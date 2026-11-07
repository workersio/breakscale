import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import './Share.css';

/* ==========================================================================
   The share dialog.

   WHY IT EXISTS AT ALL. Sharing used to be one row inside Settings, under
   a hamburger, three levels from the canvas. Someone who has just built
   something and wants to send it to a friend does not go looking in
   Settings, so the feature may as well not have shipped. It is now a
   labelled button in the top bar, because "send this to someone" is a
   thing people want to do often and a thing this project wants them to do.

   WHY A DIALOG RATHER THAN COPYING ON CLICK. Copying silently is fine
   when there is nothing to say. There is something to say here: the link
   goes through a store, and the design is encrypted before it does. A
   reader is entitled to see that before they hand a URL to someone, and
   the dialog is the only place to say it without a tooltip nobody reads.

   WHY OPENING THE DIALOG DOES NOT BUILD THE LINK. Two reasons, and the
   second is the one that matters. Opening a dialog to read what it says
   is not consent to upload the design, and a store write is the one
   moment a design leaves the browser. It is also the one irreversible
   thing here: a stored blob cannot be unstored, so it should follow a
   deliberate click rather than a curious one. The cost is real too,
   since every look would otherwise spend a write out of the day's
   budget for a link nobody ever sends.

   REPLAY LINKS. Once the run has faults in it, made by hand or loaded
   with the design, the dialog offers a second link: the design with the
   run's seed and fault schedule, so the person who opens it watches the
   same run from t=0 with each fault landing at the same simulated moment.
   It opens the way every shared design opens, reset to the start with
   the clock running. The plain link stays the design alone, so sending
   someone a design never sends them the faults you were trying out.
   A design with no faults sees the dialog exactly as it was.

   WHAT IT DELIBERATELY DOES NOT DO. No expiry picker, no "who can view",
   no account. The store cannot read a design and has no idea who made it,
   so there is nothing to configure that would mean anything.
   ========================================================================== */

/** `replay` says which link is being built: true for a replay link. */
export type ShareState =
  | { status: 'idle' }
  | { status: 'working'; replay?: boolean }
  | { status: 'ready'; url: string; replay?: boolean }
  | { status: 'failed'; message: string; replay?: boolean };

interface Props {
  open: boolean;
  state: ShareState;
  onClose: () => void;
  /** Build the link. Driven by the reader, never by opening the dialog. */
  onShare: () => void;
  /**
   * Whether the run has faults a replay link would carry. Without it, or
   * without `onShareReplay`, the dialog offers the design link alone.
   */
  replayable?: boolean;
  /** Build a replay link: the design, its seed and the fault schedule. */
  onShareReplay?: () => void;
  /** Save the design to a file instead, for anything a link cannot carry. */
  onExport: () => void;
}

export function Share({
  open,
  state,
  onClose,
  onShare,
  replayable = false,
  onShareReplay,
  onExport,
}: Props) {
  const presence = usePresence(open);
  const inputRef = useRef<HTMLInputElement>(null);
  // Which URL the clipboard holds, rather than a boolean: generating a
  // second link then leaves the button reading "Copy link" again without
  // an effect having to notice the change and reset a flag.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Select the whole link as soon as there is one, so the keyboard path is
  // Ctrl+C without a tab stop in between, and the eye lands on the thing
  // the dialog exists to hand over.
  useEffect(() => {
    if (state.status === 'ready') inputRef.current?.select();
  }, [state]);

  if (!presence.mounted) return null;

  const offerReplay = replayable && onShareReplay !== undefined;
  const replay = state.status !== 'idle' && state.replay === true;

  const copy = async () => {
    if (state.status !== 'ready') return;
    try {
      await navigator.clipboard.writeText(state.url);
    } catch {
      // Clipboard permission refused, or an insecure origin. The link is
      // already selected in the field, so there is still a way through.
      inputRef.current?.select();
      return;
    }
    setCopiedUrl(state.url);
  };

  return createPortal(
    <div className={'sh-root' + (presence.closing ? ' is-closing' : '')}>
      <div className="sh-scrim" onPointerDown={onClose} />
      <div
        className="sh-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sh-title"
      >
        <div className="sh-head">
          <h2 id="sh-title" className="sh-title">
            Share this design
          </h2>
          <button
            type="button"
            className="sh-close"
            onClick={onClose}
            aria-label="Close"
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

        {state.status === 'idle' && (
          <>
            <p className="sh-note">
              This puts the design in a store so the link stays short whatever you
              build. It is encrypted in your browser first, and the key travels in the
              part of the address your browser never sends anywhere, so the store cannot
              read it.
            </p>
            {offerReplay && (
              <p className="sh-note">
                This run has faults in it. A replay link sends them too, so whoever
                opens it watches the same run from the start, with each fault at the
                moment it happened. A plain link sends the design without them.
              </p>
            )}
            <div className="sh-row">
              {offerReplay ? (
                <>
                  <button
                    type="button"
                    className="sh-btn sh-btn-go"
                    onClick={onShareReplay}
                  >
                    Generate replay link
                  </button>
                  <button type="button" className="sh-btn" onClick={onShare}>
                    Generate link
                  </button>
                </>
              ) : (
                <button type="button" className="sh-btn sh-btn-go" onClick={onShare}>
                  Generate link
                </button>
              )}
              <button type="button" className="sh-btn sh-btn-quiet" onClick={onExport}>
                Save to a file
              </button>
            </div>
          </>
        )}

        {state.status === 'working' && <p className="sh-note">Building the link…</p>}

        {state.status === 'failed' && (
          <>
            <p className="sh-note sh-note-bad">{state.message}</p>
            <div className="sh-row">
              <button
                type="button"
                className="sh-btn"
                onClick={replay && onShareReplay ? onShareReplay : onShare}
              >
                Try again
              </button>
              <button type="button" className="sh-btn sh-btn-quiet" onClick={onExport}>
                Save to a file
              </button>
            </div>
          </>
        )}

        {state.status === 'ready' && (
          <>
            <div className="sh-row">
              <input
                ref={inputRef}
                className="sh-url"
                readOnly
                value={state.url}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={replay ? 'Link to this replay' : 'Link to this design'}
              />
              <button type="button" className="sh-btn sh-btn-go" onClick={copy}>
                {copiedUrl === state.url
                  ? 'Copied'
                  : replay
                    ? 'Copy replay link'
                    : 'Copy link'}
              </button>
            </div>
            <p className="sh-note">
              {replay
                ? 'Anyone with this link sees the same run from the start. If you changed the design partway through, the replay uses the design as it is now from the beginning.'
                : 'Anyone with this link can open the design. Sharing it again later makes a new link rather than changing this one.'}
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
