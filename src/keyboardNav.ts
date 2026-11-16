/**
 * Moving between the app's regions from the keyboard: the skip link that
 * goes straight to the diagram, and F6, which steps bar, diagram, components,
 * inspector, charts and back round, the way a browser's F6 steps between its
 * own toolbar and page.
 */

/**
 * In the order F6 visits them. A closed panel is not in the page.
 *
 * The third is the card that guides the work on the diagram: the tour, a
 * task, a brief, "Can you break it?" or an incident. It floats inside the
 * stage, and without its own stop a reader who went to the inspector to do
 * what a step asked had no key back to the step.
 */
export const REGIONS = [
  '.app-bar',
  '.app-stage .stage-canvas',
  '.tour-card, .task-card, .task > button, .chal',
  '.app-slot-left',
  '.app-slot-right',
  '.app-slot-bottom',
] as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function shown(el: HTMLElement): boolean {
  // jsdom has no layout, so a missing rect is not taken as hidden there.
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Focus the diagram: the selected part, else the first part, else the stage
 * itself (an empty canvas, whose own actions come next in Tab order).
 */
export function focusDiagram(root: ParentNode = document): boolean {
  const target =
    root.querySelector<HTMLElement>('.cv-node.is-selected') ??
    root.querySelector<HTMLElement>('.cv-node[tabindex="0"]') ??
    root.querySelector<HTMLElement>('#diagram');
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** The region an element is in, as an index into REGIONS, or -1. */
export function regionOf(el: Element | null, root: ParentNode = document): number {
  if (!el) return -1;
  // Innermost first: the guiding card sits inside the stage.
  for (let i = REGIONS.length - 1; i >= 0; i--) {
    const region = root.querySelector(REGIONS[i]!);
    if (region?.contains(el)) return i;
  }
  return -1;
}

/**
 * Move focus to the next region with something to focus in it (`dir` 1),
 * or the previous one (-1). Returns the region's index, or -1 if none did.
 */
export function cycleRegion(dir: 1 | -1, root: ParentNode = document): number {
  const n = REGIONS.length;
  const from = regionOf(document.activeElement, root);
  for (let step = 1; step <= n; step++) {
    const i = ((((from < 0 ? (dir === 1 ? -1 : 0) : from) + dir * step) % n) + n) % n;
    const region = root.querySelector<HTMLElement>(REGIONS[i]!);
    if (!region) continue;
    if (i === 1) {
      if (focusDiagram(root)) return i;
      continue;
    }
    // A card that takes focus itself is focused whole, so its heading is
    // what a screen reader says first.
    if (region.matches('[tabindex="-1"]') && shown(region)) {
      region.focus({ preventScroll: true });
      if (document.activeElement === region) return i;
    }
    const first = [...region.querySelectorAll<HTMLElement>(FOCUSABLE)].find(shown);
    if (first) {
      first.focus({ preventScroll: true });
      return i;
    }
  }
  return -1;
}
