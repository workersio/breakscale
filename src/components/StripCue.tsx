import { useEffect, useRef, useState } from 'react';
import './StripCue.css';

/**
 * "2 of 4 shown": the charts strip's scroll cue.
 *
 * At 1024 the strip is about 220px tall and shows the latency and throughput
 * charts; failures and the request trace sit below, inside a scroller with
 * nothing to say they are there. This counts the panels in the strip that
 * are in view, and while any are not, says so with a button that
 * scrolls one screen on. It renders beside the strip's `.mx` and reads it
 * from the DOM, so the strip itself is untouched.
 */
/** Space left above a panel scrolled to the top of the strip. */
const CUE_GAP = 16;

/** The strip's panels, less the pin row across its top, which is not a chart. */
const panelsOf = (strip: HTMLElement) =>
  [...strip.children].filter((el) => !el.hasAttribute('data-strip-skip'));

export function StripCue() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [count, setCount] = useState<{
    shown: number;
    total: number;
    end: boolean;
  } | null>(null);

  useEffect(() => {
    const scroller = ref.current?.parentElement?.querySelector<HTMLElement>('.mx');
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      const panels = panelsOf(scroller).filter(
        (el) => el.getBoundingClientRect().height > 0,
      );
      // In view means at least half of it: a chart whose legend runs a few
      // px past the edge is still there to read.
      let shown = 0;
      for (const el of panels) {
        const r = el.getBoundingClientRect();
        const seen = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
        if (seen >= r.height / 2) shown += 1;
      }
      const end =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const next = shown < panels.length ? { shown, total: panels.length, end } : null;
      setCount((c) =>
        c?.shown === next?.shown && c?.total === next?.total && c?.end === next?.end
          ? c
          : next,
      );
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener('scroll', soon, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    ro?.observe(scroller);
    for (const el of scroller.children) ro?.observe(el);
    return () => {
      scroller.removeEventListener('scroll', soon);
      ro?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className="btn btn-sm strip-cue"
      hidden={count === null}
      onClick={() => {
        const scroller = ref.current?.parentElement?.querySelector<HTMLElement>('.mx');
        if (!scroller) return;
        if (count?.end) {
          scroller.scrollTo({ top: 0 });
          return;
        }
        // Brings the first panel cut off at the foot up to the top edge.
        const box = scroller.getBoundingClientRect();
        const next = panelsOf(scroller).find((el) => {
          const r = el.getBoundingClientRect();
          return r.top > box.top + CUE_GAP + 1 && r.bottom > box.bottom + 1;
        });
        const top = next ? next.getBoundingClientRect().top - box.top : box.height;
        scroller.scrollTo({ top: scroller.scrollTop + top - CUE_GAP });
      }}
    >
      {count
        ? `${count.shown} of ${count.total} shown. ${count.end ? 'Back to the top' : 'More below'}`
        : null}
    </button>
  );
}
