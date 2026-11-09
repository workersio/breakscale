import { useEffect, useState } from 'react';
import { History, X } from 'lucide-react';
import type { SimSnapshot, Topology } from '../sim/types';
import {
  Timeline,
  firstAttention,
  formatAt,
  wantsAttention,
  type TimelineEvent,
} from './timeline';
import './WhatHappened.css';

interface WhatHappenedProps {
  topology: Topology;
  snapshot: SimSnapshot | null;
}

/** Lines on show. The tracker keeps more; the newest are the ones that matter. */
const SHOWN = 8;

/**
 * "What just happened": the run so far in a few dated lines, opened by itself
 * when something goes wrong and folded to a small button when closed.
 *
 * The tracker is fed every snapshot, the same stream the sparklines sample,
 * and only hands React a new list when a line was added or rewritten.
 */
export function WhatHappened({ topology, snapshot }: WhatHappenedProps) {
  const [tracker] = useState(() => new Timeline());
  const [log, setLog] = useState<{ lines: readonly TimelineEvent[]; dropped: number }>({
    lines: [],
    dropped: 0,
  });
  /** Lines up to this id have been seen and closed. */
  const [seenId, setSeenId] = useState(0);
  const [userOpen, setUserOpen] = useState(false);

  useEffect(() => {
    if (!snapshot) return;
    if (tracker.observe(topology, snapshot)) {
      setLog({ lines: [...tracker.events()], dropped: tracker.droppedCount() });
    }
  }, [tracker, topology, snapshot]);

  const { lines } = log;
  /* The panel opening by itself says nothing to a screen reader, so the line
     that opened it is read out from a status that is always mounted, before
     there is anything to say, or its first message would be missed. */
  const alert = firstAttention(lines, seenId);
  const status = (
    <div className="sr-only" role="status">
      {alert ? <span key={alert.id}>What just happened: {alert.text}</span> : null}
    </div>
  );
  // Nothing worth a look yet: no button, no panel. A healthy run stays quiet.
  if (!wantsAttention(lines, 0))
    return (
      <>
        {status}
        {null}
      </>
    );

  const open = userOpen || alert !== null;
  const shown = lines.slice(-SHOWN);
  const earlier = lines.length - shown.length + log.dropped;

  const close = () => {
    setSeenId(lines.reduce((m, e) => Math.max(m, e.id), seenId));
    setUserOpen(false);
  };

  if (!open) {
    return (
      <>
        {status}
        <div className="wh" data-chrome="what-happened">
          <button
            type="button"
            className="btn btn-sm wh-reopen"
            aria-expanded="false"
            onClick={() => setUserOpen(true)}
          >
            <History size={16} strokeWidth={1.75} aria-hidden="true" />
            What just happened
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {status}
      <div className="wh" data-chrome="what-happened">
        <section
          className="wh-panel"
          data-spot-avoid
          aria-label="What just happened"
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
        >
          <header className="wh-head">
            <h2 className="wh-title">What just happened</h2>
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon wh-close"
              aria-label="Close"
              title="Close (Esc)"
              onClick={close}
            >
              <X size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </header>
          {earlier > 0 ? (
            <p className="wh-earlier">
              {earlier === 1 ? '1 earlier line' : `${earlier} earlier lines`} not shown
            </p>
          ) : null}
          <ol className="wh-list">
            {shown.map((e) => (
              <li key={e.id} className={`wh-line is-${e.tone}`}>
                <span className="wh-at">{formatAt(e.atMs)}</span>
                <span className="wh-text">{e.text}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
