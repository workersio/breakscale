// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { encodeTopology } from './share';
import { challengeById } from './sim/challenges';
import { PRESETS, makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * The address bar says what is open. An example nobody has changed is
 * `?example=<id>`, a brief is `?challenge=<id>`, and Back and Forward move
 * through briefs the way they move through pages. A share link goes first.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = true;
  }
}

const SESSION_KEY = 'breakscale.session.v1';

/** The reader's own design: something they made, not an example. */
function ownDesign(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'mine-client', label: 'My client' };
  const svc = { ...makeNode('service', 240, 0), id: 'mine-svc', label: 'My service' };
  svc.config = { ...svc.config, capacity: 7 };
  return {
    nodes: [client, svc],
    edges: [{ id: 'mine-client->mine-svc', from: client.id, to: svc.id, weight: 1 }],
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** A press the way a finger or a mouse makes one, ending in the click. */
function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0 }));
  });
}

function byName(name: string, root: ParentNode = document): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
      (b) =>
        b.getAttribute('aria-label') === name ||
        b.textContent?.trim() === name ||
        b.querySelector('.ex-item-name')?.textContent === name,
    ) ?? null
  );
}

function must(name: string): HTMLElement {
  const el = byName(name);
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

function openMenu(item: string): void {
  press(must('Menu'));
  press(must(item));
}

function startChallenge(name: string): void {
  openMenu('Challenges');
  press(must(name));
  // The dialog's exit.
  advance(400);
}

const panel = () => document.querySelector('section.chal');
const canvasIds = () =>
  [...document.querySelectorAll('[data-hit="node"]')].map((n) =>
    n.getAttribute('data-id'),
  );
const canvasKinds = () =>
  [...document.querySelectorAll('[data-hit="node"]')].map((n) =>
    n.getAttribute('data-kind'),
  );

const hold = challengeById('hold-the-line')!;
const holdPreset = PRESETS.find((p) => p.id === hold.presetId)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ topology: ownDesign(), rps: 50, presetId: null }),
  );
});

afterEach(() => {
  if (container?.isConnected) unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const netflix = PRESETS.find((p) => p.id === 'netflix')!;

function openExample(name: string): void {
  openMenu('Examples');
  press(must(name));
  advance(400);
}

/** A press on a node, then its inspector's Delete: an edit. */
function deleteFirstNode(): void {
  press(document.querySelector('[data-hit="node"]')!);
  press(document.querySelector('.ins-delete')!);
  advance(10);
}

/** What a Back or Forward press does: the URL moves, then popstate. */
function travel(to: string): void {
  act(() => {
    window.history.replaceState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  advance(10);
}

describe('an example on the URL', () => {
  it('names an example nobody has changed, and an edit takes it off', () => {
    mount();
    advance(10);
    expect(window.location.search).toBe('');
    const before = window.history.length;
    openExample(netflix.name);
    expect(window.location.search).toBe('?example=netflix');
    // Replaced, not pushed: Back never quietly takes an example away.
    expect(window.history.length).toBe(before);
    deleteFirstNode();
    expect(window.location.search).toBe('');
    press(must('Undo'));
    advance(10);
    expect(window.location.search).toBe('?example=netflix');
  });

  it('opens from a link as one undo step, and says how to get back', () => {
    window.history.replaceState(null, '', '/?example=netflix');
    mount();
    advance(10);
    expect(canvasIds()).toEqual(netflix.topology.nodes.map((n) => n.id));
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      `Opened ${netflix.name}. Undo brings your design back.`,
    );
    press(must('Undo'));
    advance(10);
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    expect(window.location.search).toBe('');
  });

  it('ignores an example it does not know', () => {
    window.history.replaceState(null, '', '/?example=nope');
    mount();
    advance(10);
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    expect(window.location.search).toBe('');
  });

  it('lets a share link go first', async () => {
    const shared = PRESETS.find((p) => p.id === 'cache-aside')!.topology;
    const hash = await encodeTopology(shared);
    window.history.replaceState(null, '', `/?example=netflix#${hash}`);
    vi.useRealTimers();
    mount();
    await act(async () => {
      for (let i = 0; i < 50 && canvasKinds().length !== shared.nodes.length; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    expect(canvasKinds()).toEqual(shared.nodes.map((n) => n.kind));
    // The link on screen keeps its own address.
    expect(window.location.hash).toBe(`#${hash}`);
  });

  it('takes a share link off once an example replaces it', async () => {
    const shared = PRESETS.find((p) => p.id === 'cache-aside')!.topology;
    window.history.replaceState(null, '', `/#${await encodeTopology(shared)}`);
    vi.useRealTimers();
    mount();
    await act(async () => {
      for (let i = 0; i < 50 && canvasKinds().length !== shared.nodes.length; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    openMenu('Examples');
    press(must(netflix.name));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?example=netflix');
  });
});

describe('a challenge on the URL', () => {
  it('pushes a brief, and Back brings the design that was set aside', () => {
    mount();
    advance(10);
    const before = window.history.length;
    startChallenge(hold.name);
    expect(window.location.search).toBe('?challenge=hold-the-line');
    expect(window.history.length).toBe(before + 1);

    travel('/');
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);

    travel('/?challenge=hold-the-line');
    expect(panel()?.textContent).toContain(hold.name);
    expect(canvasIds()).toEqual(holdPreset.topology.nodes.map((n) => n.id));
  });

  it('leaving by the button is a step too, and an example comes back named', () => {
    mount();
    openExample(netflix.name);
    startChallenge(hold.name);
    const inside = window.history.length;
    press(must('Back to my design'));
    advance(10);
    expect(window.location.search).toBe('?example=netflix');
    expect(window.history.length).toBe(inside + 1);
  });

  it('follows Back to a brief it was never in this session', () => {
    mount();
    advance(10);
    travel('/?challenge=keep-it-warm');
    expect(panel()?.textContent).toContain(challengeById('keep-it-warm')!.name);
    travel('/?challenge=not-a-brief');
    expect(panel()).toBeNull();
  });

  it('copies a link that opens only this brief', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    mount();
    startChallenge(hold.name);
    press(must('Copy link'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/?challenge=hold-the-line`,
    );
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'Copied a link to this challenge.',
    );
  });
});
