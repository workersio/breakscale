// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { CHALLENGES_KEY } from './challengeWorkspace';
import { saveDesign } from './savedDesigns';
import { buildDesignFile } from './designFile';
import { encodeTopology } from './share';
import { challengeById } from './sim/challenges';
import { PRESETS, makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * A challenge is its own workspace. These mount the whole app, because the
 * promise is about everything around the panel: the reader's own design is
 * set aside without a question, nothing inside the brief writes over it,
 * leaving puts it back exactly, a reload comes back to the brief, and the
 * ways out of a brief (undo, opening something else, a share link) all end
 * in the reader's own workspace.
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
const storedSession = () =>
  JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as {
    topology: Topology;
  } | null;
const storedChallenges = () =>
  JSON.parse(localStorage.getItem(CHALLENGES_KEY) ?? 'null');

/** Let the automatic check run to its verdict. */
function settleCheck(): void {
  for (let i = 0; i < 60; i++) {
    advance(250);
    const chip = document.querySelector('.chal-chip')?.textContent;
    if (chip && chip !== 'Changed' && chip !== 'Not checked yet' && chip !== 'Checking')
      return;
  }
}

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

describe('starting a challenge', () => {
  it('sets the design aside without asking, and never writes over it', () => {
    const confirm = vi.spyOn(window, 'confirm');
    mount();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    startChallenge(hold.name);

    expect(confirm).not.toHaveBeenCalled();
    expect(panel()?.textContent).toContain(hold.name);
    expect(canvasIds()).toEqual(holdPreset.topology.nodes.map((n) => n.id));
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'Your design is set aside. It comes back when you leave.',
    );

    // The brief autosaves into its own slot. The reader's stays as it was.
    advance(2000);
    expect(storedSession()?.topology).toEqual(ownDesign());
    const store = storedChallenges();
    expect(store.active).toBe(hold.id);
    expect(
      store.attempts[hold.id].topology.nodes.map((n: { id: string }) => n.id),
    ).toEqual(holdPreset.topology.nodes.map((n) => n.id));
  });

  it('takes focus to the brief it opened', () => {
    mount();
    startChallenge(hold.name);
    expect(document.activeElement).toBe(panel()?.querySelector('h2'));
  });

  it('holds the load still, and hides the suggested fix', () => {
    mount();
    startChallenge(hold.name);
    const slider = document.querySelector<HTMLInputElement>('.traffic-load input');
    expect(slider?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Set by the challenge you are in.');
    advance(20_000);
    const db = document.querySelector('[data-hit="node"][data-kind="db"]')!;
    press(db);
    expect(document.querySelector('.ins')).not.toBeNull();
    expect(document.querySelector('.ins')?.textContent).not.toContain('Suggested fix');
    // How long the work takes is the brief's, not the reader's.
    const fixed = [...document.querySelectorAll('.ins .is-locked')].map(
      (el) => el.querySelector('label')?.textContent,
    );
    expect(fixed.length).toBeGreaterThan(0);
  });
});

describe('leaving a challenge', () => {
  it('puts the reader design back exactly, with a short toast', () => {
    mount();
    startChallenge(hold.name);
    advance(3000);
    press(must('Back to my design'));
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'Back to your design.',
    );
    advance(1000);
    expect(storedSession()?.topology).toEqual(ownDesign());
    // The attempt is kept, for next time.
    const store = storedChallenges();
    expect(store.active).toBeNull();
    expect(store.attempts[hold.id]).toBeDefined();
  });

  it('comes back to the attempt, with a way to start over', () => {
    mount();
    startChallenge(hold.name);
    advance(1000);
    press(must('Back to my design'));
    startChallenge(hold.name);
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'Picked up where you left off.',
    );
    expect(panel()).not.toBeNull();
  });

  it('is what undoing past the start does, and redo goes back in', () => {
    mount();
    startChallenge(hold.name);
    advance(1000);
    press(must('Undo'));
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    press(must('Redo'));
    expect(panel()?.textContent).toContain(hold.name);
    expect(canvasIds()).toEqual(holdPreset.topology.nodes.map((n) => n.id));
    advance(1000);
    expect(storedSession()?.topology).toEqual(ownDesign());
  });

  it('is what opening an example does, and the attempt waits', () => {
    mount();
    startChallenge(hold.name);
    advance(1000);
    openMenu('Examples');
    const other = PRESETS.find((p) => p.id !== hold.presetId)!;
    press(must(other.name));
    advance(400);
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(other.topology.nodes.map((n) => n.id));
    press(must('Undo'));
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    openMenu('Challenges');
    const card = must(hold.name);
    expect(card.textContent).toContain('In progress');
  });

  it('brings back newer work another tab saved, not the copy set aside', () => {
    mount();
    startChallenge(hold.name);
    advance(1000);
    const newer = ownDesign();
    newer.nodes[1].config = { ...newer.nodes[1].config, capacity: 9 };
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ topology: newer, rps: 50, presetId: null }),
    );
    press(must('Back to my design'));
    advance(1000);
    expect(storedSession()?.topology).toEqual(newer);
  });
});

describe('opening something else from inside a brief', () => {
  it('leaves the brief for a saved design', () => {
    const saved = PRESETS.find((p) => p.id === 'cache-aside')!.topology;
    saveDesign('Kept for later', structuredClone(saved));
    mount();
    startChallenge(hold.name);
    openMenu('Your designs');
    const open = [...document.querySelectorAll('.dz-open')].find((b) =>
      b.textContent?.includes('Kept for later'),
    );
    press(open!);
    advance(400);
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(saved.nodes.map((n) => n.id));
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'Opened Kept for later in place of your design. Undo brings yours back.',
    );
    // It replaced the reader's own design, as opening it from there would,
    // so one undo brings that back rather than the brief.
    press(must('Undo'));
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    advance(1000);
    expect(storedSession()?.topology).toEqual(ownDesign());
    press(must('Undo'));
    expect(panel()?.textContent).toContain(hold.name);
  });

  it('leaves the brief for an imported file', async () => {
    mount();
    startChallenge(hold.name);
    const file = new File([buildDesignFile(ownDesign(), 'Mine')], 'mine.breakscale', {
      type: 'application/json',
    });
    const input = document.querySelector<HTMLInputElement>('.app-file-input')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    vi.useRealTimers();
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 50 && panel(); i++)
        await new Promise((r) => setTimeout(r, 5));
    });
    expect(document.querySelector('.app-toast-error')?.textContent ?? '').toBe('');
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
  });
});

describe('the fixed fields', () => {
  it('refuse a change that reaches the handler anyway', () => {
    mount();
    startChallenge(hold.name);
    press(document.querySelector('[data-hit="node"][data-kind="db"]')!);
    const row = [...document.querySelectorAll('.ins .is-locked')].find(
      (r) => r.querySelector('label')?.textContent?.trim() === 'Service time',
    )!;
    const input = row.querySelector('input')!;
    const before = input.value;
    // Past the disabled control, as any other path to the handler would be.
    input.disabled = false;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      set.call(input, String(Number(before) === 2 ? 3 : 2));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    advance(1000);
    const db = storedChallenges().attempts[hold.id].topology.nodes.find(
      (n: { kind: string }) => n.kind === 'db',
    );
    const start = holdPreset.topology.nodes.find((n) => n.kind === 'db')!;
    expect(db.config.serviceMs).toBe(start.config.serviceMs);
    expect(db.config.serviceCv).toBe(start.config.serviceCv);
  });
});

describe('two tabs', () => {
  it('keep the passes and attempts each other recorded', () => {
    mount();
    // Another tab passes a brief after this one read the store.
    localStorage.setItem(
      CHALLENGES_KEY,
      JSON.stringify({
        active: null,
        attempts: {},
        progress: {
          'keep-it-warm': {
            version: challengeById('keep-it-warm')!.version,
            passedAt: '2026-01-01T00:00:00.000Z',
            hintsUsed: 0,
          },
        },
      }),
    );
    startChallenge(hold.name);
    advance(1000);
    const store = storedChallenges();
    expect(store.progress['keep-it-warm']).toBeDefined();
    expect(store.attempts[hold.id]).toBeDefined();
    expect(store.active).toBe(hold.id);
  });
});

describe('across a reload', () => {
  it('comes back to the brief, and leaving still restores the design', () => {
    mount();
    startChallenge(hold.name);
    advance(2000);
    unmount();

    mount();
    expect(panel()?.textContent).toContain(hold.name);
    expect(canvasIds()).toEqual(holdPreset.topology.nodes.map((n) => n.id));
    // A reload is not the reader starting it, so focus stays where it was.
    expect(document.activeElement).not.toBe(panel()?.querySelector('h2'));
    press(must('Back to my design'));
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
  });

  it('opens a brief from a challenge link, and takes the link off the URL', () => {
    window.history.replaceState(null, '', '/?challenge=keep-it-warm');
    mount();
    expect(panel()?.textContent).toContain(challengeById('keep-it-warm')!.name);
    advance(10);
    expect(window.location.search).toBe('');
    // Boot moved the reader out of their own design, so it says so.
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'Your design is set aside. It comes back when you leave.',
    );
    press(must('Back to my design'));
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
  });

  it('lets a share link open over a brief without touching the reader design', async () => {
    mount();
    startChallenge(hold.name);
    advance(2000);
    unmount();

    const shared = PRESETS.find((p) => p.id === 'cache-aside')!.topology;
    window.history.replaceState(null, '', `/#${await encodeTopology(shared)}`);
    vi.useRealTimers();
    mount();
    await act(async () => {
      for (let i = 0; i < 50 && canvasKinds().length !== shared.nodes.length; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });
    expect(panel()).toBeNull();
    // A link carries the design, not the ids it was drawn with.
    expect(canvasKinds()).toEqual(shared.nodes.map((n) => n.kind));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    // Nobody edited the shared design, so nothing was saved over theirs, and
    // the brief is still waiting.
    expect(storedSession()?.topology).toEqual(ownDesign());
    expect(storedChallenges().attempts[hold.id]).toBeDefined();
  });
});

describe('a brief started from a share link', () => {
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });

  async function openShared(): Promise<Topology> {
    const shared = PRESETS.find((p) => p.id === 'cache-aside')!.topology;
    window.history.replaceState(null, '', `/#${await encodeTopology(shared)}`);
    vi.useRealTimers();
    mount();
    for (let i = 0; i < 50 && canvasKinds().length !== shared.nodes.length; i++) {
      await wait(10);
    }
    expect(canvasKinds()).toEqual(shared.nodes.map((n) => n.kind));
    return shared;
  }

  async function start(): Promise<void> {
    openMenu('Challenges');
    press(must(hold.name));
    await wait(450);
    expect(panel()?.textContent).toContain(hold.name);
  }

  it('never saves the shared design over the reader design when undone', async () => {
    await openShared();
    await start();
    await wait(600);
    expect(storedSession()?.topology).toEqual(ownDesign());
    press(must('Undo'));
    expect(panel()).toBeNull();
    await wait(600);
    expect(storedSession()?.topology).toEqual(ownDesign());
  });

  it('takes the link off the URL, so a reload comes back to the brief', async () => {
    await openShared();
    await start();
    expect(window.location.hash).toBe('');
    await wait(600);
    unmount();
    mount();
    expect(panel()?.textContent).toContain(hold.name);
    press(must('Back to my design'));
    await wait(600);
    expect(storedSession()?.topology).toEqual(ownDesign());
  });
});

describe('the check', () => {
  it('runs on its own once the design settles, and never passes the brief as it ships', () => {
    mount();
    startChallenge(hold.name);
    expect(document.querySelector('.chal-chip')?.textContent).toBe('Not checked yet');
    settleCheck();
    expect(document.querySelector('.chal-chip')?.textContent).toBe('Not yet');
    expect(panel()?.textContent).not.toContain(hold.lesson);
    press(must('Details'));
    expect(byName('Watch run 1')).not.toBeNull();
  });

  it('passes a fixed design, records it, and shows the lesson', () => {
    mount();
    startChallenge(hold.name);
    const db = document.querySelector('[data-hit="node"][data-kind="db"]')!;
    press(db);
    const label = [...document.querySelectorAll('.ins label')].find(
      (l) => l.textContent?.trim() === 'Slots per instance',
    );
    const input = document.getElementById(
      label!.getAttribute('for')!,
    ) as HTMLInputElement;
    const start = Number(input.value);
    act(() => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      set.call(input, String(start + 4));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    settleCheck();
    expect(document.querySelector('.chal-chip')?.textContent).toBe('Passed');
    expect(panel()?.textContent).toContain(hold.lesson);
    expect(storedChallenges().progress[hold.id]?.version).toBe(hold.version);

    // Watching the run keeps the pass: the design is the same one.
    press(must('Details'));
    const watch = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Watch run'),
    );
    expect(watch).toBeDefined();
    press(watch!);
    expect(document.querySelector('.chal-chip')?.textContent).toBe('Passed');

    press(must('Back to my design'));
    openMenu('Challenges');
    expect(must(hold.name).textContent).toContain('Passed');
  });
});
