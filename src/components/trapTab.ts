/**
 * Keep Tab inside a modal dialog.
 *
 * A dialog marked aria-modal tells a screen reader the page behind it is out
 * of reach, and a Tab that walks out into that page strands a keyboard user
 * somewhere they cannot see. Call it from the dialog's keydown handler: it
 * wraps Tab from the last control to the first, and Shift+Tab the other way.
 * The controls are read when the key is pressed, since a list can change as
 * the reader types.
 */

const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/** The controls Tab stops at inside `root`, in order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if (el.closest('[hidden], [inert]')) return false;
    // Tab stops at one radio of a group: the checked one, else the first.
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const group = [
        ...root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ].filter((r) => r.name === el.name);
      const checked = group.find((r) => r.checked);
      return checked ? checked === el : group[0] === el;
    }
    return true;
  });
}

export function trapTab(
  e: { key: string; shiftKey: boolean; preventDefault(): void },
  root: HTMLElement | null,
): void {
  if (e.key !== 'Tab' || !root) return;
  const stops = tabbables(root);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) {
    e.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  if (e.shiftKey) {
    if (!inside || active === first || active === root) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    e.preventDefault();
    first.focus();
  }
}
