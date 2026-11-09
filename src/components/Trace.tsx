import { memo, useMemo } from 'react';
import { Term } from './Tooltip';
import type { RequestTrace } from '../sim/types';
import './Trace.css';

/* ==========================================================================
   One request, hop by hop, split into waiting and working.

   WHY IT EXISTS. Every other reading in this app is an aggregate: a rate, a
   percentile, a mean. Those say latency ROSE. None of them say WHERE it
   went, and a student watching p99 climb from 40ms to 400ms has no way to
   tell whether the work got slower or whether the request simply stood in a
   line. Under load it is almost always the line, and that is the single most
   important thing this simulator has to teach.

   So: one real request, not a statistic. An average of queueing is less
   convincing than one honest example of it, and a student can point at a bar
   and say "that node is where my request waited".

   The two bars are the whole design. Service barely moves as load rises;
   queued grows without bound. Putting them side by side on one row, at one
   scale, makes that comparison automatic rather than arithmetic.
   ========================================================================== */

export interface TraceProps {
  trace: RequestTrace | null;
  /** Resolve a node id to the name shown on the canvas. */
  nameOf: (id: string) => string;
  /** Said instead of the waiting line when the shell knows why nothing ran. */
  idleText?: string;
}

/** Widest total on any row, so every bar shares one scale. */
function scaleOf(trace: RequestTrace): number {
  let max = 0;
  for (const h of trace.hops) {
    const t = h.queuedMs + h.serviceMs;
    if (t > max) max = t;
  }
  return max;
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

export const Trace = memo(function Trace({ trace, nameOf, idleText }: TraceProps) {
  const totals = useMemo(() => {
    if (!trace) return null;
    let queued = 0;
    let service = 0;
    for (const h of trace.hops) {
      queued += h.queuedMs;
      service += h.serviceMs;
    }
    return { queued, service, scale: scaleOf(trace) };
  }, [trace]);

  if (!trace || !totals) {
    return (
      <section className="tr" aria-label="Request trace">
        <header className="mx-head">
          <span className="label mx-eyebrow">One request</span>
        </header>
        <p className="tr-empty">
          {idleText ??
            'Waiting for a request to finish. Press play, or raise the load.'}
        </p>
      </section>
    );
  }

  const { queued, service, scale } = totals;
  // Which half of the latency dominates. This is the sentence the panel is
  // for, so it is stated in words rather than left to be inferred from two
  // bar lengths.
  const verdict =
    queued > service * 1.5
      ? 'Most of this request was spent waiting, not working.'
      : queued < service * 0.25
        ? 'Almost all of this was real work. Nothing was queueing.'
        : 'Waiting and working are close. Raise the load to see that change.';

  return (
    <section className="tr" aria-label="Request trace">
      <header className="mx-head">
        <span className="label mx-eyebrow">One request</span>
        <span className="mx-head-right">
          <span className="mx-readout-wrap">
            <span className={`num num-lg mx-readout${trace.ok ? '' : ' is-danger'}`}>
              {fmt(trace.totalMs)}
            </span>
            <span className="unit mx-unit">ms</span>
          </span>
        </span>
      </header>

      {!trace.ok && (
        <p className="tr-failed">
          This one did not finish: <strong>{trace.reason}</strong>. The hops below are
          how far it got.
        </p>
      )}

      <ol className="tr-rows">
        {trace.hops.map((h, i) => {
          const total = h.queuedMs + h.serviceMs;
          const pct = (v: number) => (scale > 0 ? (v / scale) * 100 : 0);
          return (
            <li
              className="tr-row"
              // Depth and id are not unique on their own: a retried call hits
              // the same node at the same depth twice, and that repetition is
              // exactly what the retry examples are meant to show.
              key={`${h.nodeId}-${h.depth}-${i}`}
            >
              <span className="tr-name" title={nameOf(h.nodeId)}>
                {nameOf(h.nodeId)}
              </span>
              <span className="tr-bar">
                <span className="tr-queued" style={{ width: `${pct(h.queuedMs)}%` }} />
                <span
                  className="tr-service"
                  style={{ width: `${pct(h.serviceMs)}%` }}
                />
              </span>
              <span className="num tr-ms">{fmt(total)}</span>
            </li>
          );
        })}
      </ol>

      <footer className="tr-foot">
        <span className="tr-key">
          <span className="tr-swatch tr-queued" />
          <Term id="queue">waiting</Term> {fmt(queued)}ms
        </span>
        <span className="tr-key">
          <span className="tr-swatch tr-service" />
          working {fmt(service)}ms
        </span>
      </footer>
      <p className="tr-verdict">{verdict}</p>
    </section>
  );
});
