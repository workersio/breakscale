import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import { hasStore } from '../share/store';
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

   TWO OPTIONS, SIDE BY SIDE. Once the run has faults in it, made by hand
   or loaded with the design, there are two different things to send: the
   design alone, or this exact run (the design with the run's seed and
   fault schedule, so the person who opens it watches each fault land at
   the same simulated moment). They sit side by side, each saying in one
   line what the recipient will see, and each keeps its own link, so
   copying one never takes the other away. The design link stays the
   design alone, so sending someone a design never sends them the faults
   you were trying out. A design with no faults sees the one option.

   ONE CLICK BUILDS AND COPIES. Copy link is still the deliberate click
   the store write waits for; it just also does the obvious next thing.
   The clipboard write is started inside the click, with the link as a
   promise, because Safari drops the user's permission across an await
   and a store round trip is one. Where that is not supported it falls
   back to writing after the await, and where that fails too the link
   sits selected in the field for Ctrl+C. Clicking again copies the same
   link without writing another one to the store.

   WHAT IT DELIBERATELY DOES NOT DO. No expiry picker, no "who can view",
   no account. The store cannot read a design and has no idea who made it,
   so there is nothing to configure that would mean anything.
   ========================================================================== */

/** Which link a row builds: the design alone, or this exact run. */
export type ShareKind = 'design' | 'run';

/** What building a link came to. Never a rejected promise. */
export type ShareResult = { ok: true; url: string } | { ok: false; message: string };

/** One row's link, from nothing to built. */
type LinkState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'ready'; url: string }
  | { status: 'failed'; message: string };

const IDLE: LinkState = { status: 'idle' };

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Build a link of this kind. Driven by the reader, never by opening the
   * dialog. Remount the dialog (a new `key`) to forget the links it built.
   */
  onBuild: (kind: ShareKind) => Promise<ShareResult>;
  /** Whether the run has faults a replay link would carry. */
  replayable?: boolean;
  /** Save the design to a file instead, for anything a link cannot carry. */
  onExport: () => void;
}

interface Option {
  kind: ShareKind;
  title: string;
  blurb: string;
  label: string;
}

const OPTIONS: readonly Option[] = [
  {
    kind: 'design',
    title: 'This design',
    blurb: 'They get your boxes and settings, and it runs fresh from the start.',
    label: 'Link to this design',
  },
  {
    kind: 'run',
    title: 'This exact run',
    blurb:
      'They watch this run from the start, with each fault at the moment it happened.',
    label: 'Link to this exact run',
  },
];

/**
 * Start a clipboard write now, while the click still counts as the user's,
 * with the text arriving later. Null where the browser cannot take a
 * promise, so the caller falls back to writing once the text is in hand.
 */
function writeLater(text: Promise<string | null>): Promise<boolean> | null {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return null;
  try {
    const blob = text.then((t) =>
      t === null
        ? Promise.reject(new Error('no link'))
        : new Blob([t], { type: 'text/plain' }),
    );
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(
      () => true,
      () => false,
    );
  } catch {
    return null;
  }
}

async function writeNow(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission refused, or an insecure origin.
    return false;
  }
}

export function Share({ open, onClose, onBuild, replayable = false, onExport }: Props) {
  const presence = usePresence(open);
  const [links, setLinks] = useState<Record<ShareKind, LinkState>>({
    design: IDLE,
    run: IDLE,
  });
  // Which URL the clipboard holds, rather than a flag per row: copying one
  // row then puts the other back to "Copy link" without an effect having
  // to notice and reset it.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // What the live region says. Set only by a copy attempt, so opening the
  // dialog announces nothing beyond the dialog itself.
  const [status, setStatus] = useState('');
  const fieldRefs = useRef<Partial<Record<ShareKind, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!presence.mounted) return null;

  const setLink = (kind: ShareKind, next: LinkState) =>
    setLinks((prev) => ({ ...prev, [kind]: next }));

  /** The link landed but the clipboard refused it: hand over the field. */
  const manual = (kind: ShareKind) => {
    setStatus('Link ready. Copy it from the field.');
    // After the field renders, so there is something to select.
    requestAnimationFrame(() => fieldRefs.current[kind]?.select());
  };

  const copy = async (kind: ShareKind) => {
    const link = links[kind];
    if (link.status === 'working') return;
    if (link.status === 'ready') {
      // Already built: copy it again rather than storing a second copy.
      if (await writeNow(link.url)) {
        setCopiedUrl(link.url);
        setStatus('Link copied');
      } else manual(kind);
      return;
    }
    setLink(kind, { status: 'working' });
    setStatus('');
    const built = onBuild(kind);
    const early = writeLater(built.then((r) => (r.ok ? r.url : null)));
    const result = await built;
    if (!result.ok) {
      setLink(kind, { status: 'failed', message: result.message });
      setStatus(result.message);
      return;
    }
    setLink(kind, { status: 'ready', url: result.url });
    const copied = (early !== null && (await early)) || (await writeNow(result.url));
    if (copied) {
      setCopiedUrl(result.url);
      setStatus('Link copied');
    } else manual(kind);
  };

  const options = replayable ? OPTIONS : OPTIONS.slice(0, 1);

  return createPortal(
    <div className={'sh-root' + (presence.closing ? ' is-closing' : '')}>
      <div className="sh-scrim" onPointerDown={onClose} />
      <div
        className={'sh-card' + (options.length > 1 ? ' is-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sh-title"
      >
        <div className="sh-head">
          <h2 id="sh-title" className="sh-title">
            Share
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

        <div className="sh-options">
          {options.map((o) => {
            const link = links[o.kind];
            const copied = link.status === 'ready' && copiedUrl === link.url;
            const headId = `sh-opt-${o.kind}`;
            return (
              <section key={o.kind} className="sh-option" aria-labelledby={headId}>
                <h3 id={headId} className="sh-option-title">
                  {o.title}
                </h3>
                <p className="sh-note">{o.blurb}</p>
                {link.status === 'failed' && (
                  <p className="sh-note sh-note-bad">{link.message}</p>
                )}
                {link.status === 'ready' && (
                  <input
                    ref={(el) => {
                      fieldRefs.current[o.kind] = el;
                    }}
                    className="sh-url"
                    readOnly
                    value={link.url}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label={o.label}
                  />
                )}
                {link.status === 'ready' && o.kind === 'run' && (
                  <p className="sh-note">
                    If you changed the design partway through, the replay uses it as it
                    is now.
                  </p>
                )}
                <button
                  type="button"
                  className={'sh-btn sh-btn-go sh-copy' + (copied ? ' is-copied' : '')}
                  onClick={() => void copy(o.kind)}
                  // Not `disabled`: that would drop keyboard focus to the page
                  // in the middle of the one thing the reader is waiting on.
                  aria-disabled={link.status === 'working' || undefined}
                  aria-describedby={headId}
                >
                  {copied && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                  {link.status === 'working'
                    ? 'Making link…'
                    : link.status === 'failed'
                      ? 'Try again'
                      : copied
                        ? 'Copied'
                        : 'Copy link'}
                </button>
              </section>
            );
          })}
        </div>

        <div className="sh-foot">
          {/* Without a store the design rides in the link itself, and nothing
              is stored or encrypted, so the claim is only made when true. */}
          <p className="sh-note">
            {hasStore()
              ? 'Encrypted in your browser before it is stored. The store cannot read it.'
              : 'The design travels inside the link itself.'}
          </p>
          <button type="button" className="sh-btn sh-btn-quiet" onClick={onExport}>
            Save to a file
          </button>
        </div>

        <div className="sr-only" role="status">
          {status}
        </div>
      </div>
    </div>,
    document.body,
  );
}
