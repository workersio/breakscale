// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EdgeCues } from './EdgeCues';
import type { FitView } from './fit';
import type { SimNode } from '../sim/types';

/**
 * The edge cues on a 390px phone. jsdom does no layout, so the surface and
 * the visible rect are handed in as fixed rects: 390 wide, the visible part
 * from 300 to 700. The diagram is a row of cards 184 wide at 1.0, so it runs
 * far past the right edge.
 */

const surface = new DOMRect(0, 300, 390, 400);
const node = (id: string, x: number) => ({ id, x, y: 0 }) as unknown as SimNode;
const row = [node('a', 0), node('b', 240), node('c', 480), node('d', 720)];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness({ start }: { start: FitView }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<FitView>(start);
  return (
    <div ref={hostRef} data-x={view.x}>
      <EdgeCues
        hostRef={hostRef}
        visibleRef={undefined}
        visibleRect={() => ({ surface, view: surface })}
        view={view}
        nodes={row}
        nodeW={184}
        nodeH={88}
        setView={setView}
        onFit={() => {}}
      />
    </div>
  );
}

const frame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

const cue = (side: 'left' | 'right') =>
  container.querySelector<HTMLButtonElement>(`.cv-cue.is-${side}`);

describe('edge cues', () => {
  it('shows a cue only on the side with boxes past it', async () => {
    act(() => root.render(<Harness start={{ x: 24, y: 0, k: 1 }} />));
    await frame();
    expect(cue('right')).not.toBeNull();
    expect(cue('left')).toBeNull();
    expect(cue('right')?.getAttribute('data-chrome')).not.toBeNull();
    expect(cue('right')?.getAttribute('aria-label')).toBe(
      'Show more of the diagram on the right',
    );
  });

  it('pans toward the hidden boxes when pressed', async () => {
    act(() => root.render(<Harness start={{ x: 24, y: 0, k: 1 }} />));
    await frame();
    act(() => cue('right')?.click());
    await frame();
    expect(Number(container.firstElementChild?.getAttribute('data-x'))).toBeLessThan(
      24,
    );
    expect(cue('left')).not.toBeNull();
  });

  it('hands focus to the other cue when its own side is spent', async () => {
    // 100px left to go, less than one press, so this press spends the side.
    act(() => root.render(<Harness start={{ x: -438, y: 0, k: 1 }} />));
    await frame();
    const right = cue('right');
    act(() => right?.focus());
    expect(document.activeElement).toBe(right);
    act(() => right?.click());
    await frame();
    expect(cue('right')).toBeNull();
    expect(document.activeElement).toBe(cue('left'));
  });
});
