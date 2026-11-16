/**
 * Centres `el` in the nearest ancestor that scrolls on purpose (overflow-y
 * auto or scroll), and nothing else.
 *
 * `scrollIntoView` walks EVERY scrolling ancestor, including the ones that
 * are only `overflow: hidden` to clip: on a tablet the tour's call scrolled
 * `.app-body` 13px as well as the inspector, and the whole app stayed
 * shifted up under the top bar with no way back. Only the panel's own list
 * should move.
 */
export function scrollWithin(el: Element): void {
  let box = el.parentElement;
  while (box) {
    const y = getComputedStyle(box).overflowY;
    if ((y === 'auto' || y === 'scroll') && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box) return;
  const target = el.getBoundingClientRect();
  const frame = box.getBoundingClientRect();
  const offset = target.top - frame.top - (frame.height - target.height) / 2;
  box.scrollTop = Math.max(0, box.scrollTop + offset);
}
