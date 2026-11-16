import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Drops the ledger's trailing facts (the clock, then the connections, then
 * the breakdown) while the row would run under the zoom cluster.
 *
 * The room the ledger has is set in CSS (a max-width from the panel tokens,
 * see App.css), and a capped flex row that wraps would keep its full width
 * with the dropped facts gone, leaving an empty pill. So the count is worked
 * out here instead: show everything, measure, and hide one more from the end
 * until the row fits, all in one synchronous pass so no frame paints between.
 * The result is a `data-drop` attribute that CSS turns into display: none.
 */
export function useLedgerFit(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const fit = () => {
      // Clipped, the row's scroll width outgrows its client width.
      const facts = el.children.length;
      for (let drop = 0; drop < facts - 1; drop++) {
        el.dataset.drop = String(drop);
        if (el.scrollWidth <= el.clientWidth + 1) return;
      }
      el.dataset.drop = String(facts - 1);
    };
    fit();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(el);
    if (el.parentElement) ro?.observe(el.parentElement);
    // A panel opening changes the room through a class on the shell, which
    // resizes neither element.
    const shell = el.closest('.app-body');
    const mo =
      shell && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(fit)
        : null;
    if (shell)
      mo?.observe(shell, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref, active]);
}
