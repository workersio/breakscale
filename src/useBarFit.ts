import { useLayoutEffect, useState } from 'react';
import { PHONE_QUERY } from './phoneQuery';

/**
 * Whether the top bar's three islands fit on one row, measured rather than
 * guessed from a breakpoint.
 *
 * The old answer was a viewport width (1000px) chosen from arithmetic that
 * stopped being true as soon as the bar gained a star count and a labelled
 * "Can you break it?". Below about 1180px the load island overflowed into
 * the menu island and Pause, Step and Reset were drawn underneath GitHub,
 * Share and Menu: visible, and impossible to press.
 *
 * So the bar is asked. Each time it or anything in it changes size, it is
 * laid out as one row for the length of one synchronous read, checked for
 * overflow, and put back. Nothing paints in between, so the reader never
 * sees the row it was tested in. The answer is written to `data-fit` by the
 * caller, and App.css stacks the load island under the other two when it is
 * `compact`.
 *
 * Phones have their own two-row header and never ask.
 */

/** Sub-pixel layout rounds both ways; a 1px overrun is not an overlap. */
const SLACK_PX = 1;

/**
 * True when the islands, laid out as one row, would overlap or leave the
 * bar. Exported for the unit test, which drives it with stub geometry.
 */
export function rowOverflows(bar: HTMLElement, minSliderPx = 0): boolean {
  const barRight = bar.getBoundingClientRect().right;
  for (const island of bar.querySelectorAll<HTMLElement>('.app-island')) {
    if (island.scrollWidth > island.clientWidth + SLACK_PX) return true;
    if (island.getBoundingClientRect().right > barRight + SLACK_PX) return true;
  }
  // The load island is allowed to shrink, so its content is what overflows:
  // the traffic control's pieces have floors and spill past its edge.
  const traffic = bar.querySelector<HTMLElement>('.traffic');
  if (traffic !== null && traffic.scrollWidth > traffic.clientWidth + SLACK_PX)
    return true;
  // Or nothing spills and the slider is what gave way. Presenting's larger
  // figures squeezed it to 50px at 768 wide without overflowing anything.
  if (minSliderPx <= 0) return false;
  const slider = bar.querySelector<HTMLElement>('.traffic input[type="range"]');
  return slider !== null && slider.getBoundingClientRect().width < minSliderPx;
}

/**
 * `minSliderPx`, when set, also counts a row whose load slider came out
 * narrower than that as not fitting. Off for the normal bar, whose row
 * keeps a short slider by design (87px at 1280); presenting sets it, so a
 * room gets a slider it can see being dragged.
 */
export function useBarFit(
  barRef: React.RefObject<HTMLElement | null>,
  minSliderPx = 0,
): boolean {
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const phone = window.matchMedia?.(PHONE_QUERY);

    let live = true;
    const measure = () => {
      if (!live) return;
      if (phone?.matches) {
        setCompact(false);
        return;
      }
      // React owns the attribute; this borrows it for one read and hands it
      // back unchanged, and the state update below lets React write the
      // answer on its next commit.
      const rendered = bar.dataset.fit;
      bar.dataset.fit = 'row';
      const overflows = rowOverflows(bar, minSliderPx);
      if (rendered === undefined) delete bar.dataset.fit;
      else bar.dataset.fit = rendered;
      setCompact(overflows);
    };

    // The bar for the window, and every island for what is inside it: a star
    // count arriving or a brief hiding "Can you break it?" changes what fits
    // without changing the bar's own width.
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    for (const el of bar.querySelectorAll(
      '.app-island, .traffic-headline, .traffic-actions',
    )) {
      ro.observe(el);
    }
    phone?.addEventListener?.('change', measure);
    // The web font is wider than the fallback the first measure ran against.
    void document.fonts?.ready.then(measure);
    measure();
    return () => {
      live = false;
      ro.disconnect();
      phone?.removeEventListener?.('change', measure);
    };
  }, [barRef, minSliderPx]);

  return compact;
}
