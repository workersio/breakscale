// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { challengeById } from '../sim/challenges';
import { INCIDENTS, incidentById } from '../sim/incidents';
import { makeNode } from '../sim/presets';
import type { Topology } from '../sim/types';

/**
 * Challenges and real outages as steps of the learning path, in the whole
 * app: each opens through the panel its own picker opens, a pass says what
 * was learned whatever was folded or covering it, and Next goes on along
 * the path rather than the picker's order.
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

function ownDesign(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'mine-client', label: 'My client' };
  const svc = { ...makeNode('service', 240, 0), id: 'mine-svc', label: 'My service' };
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

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function press(el: Element, pointerType = 'mouse'): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerdown', { ...at, buttons: 1, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerup', { ...at, buttons: 0, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  });
}

function find(name: string, scope: ParentNode = document): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
    ) ?? null
  );
}

function must(name: string, scope: ParentNode = document): HTMLElement {
  const el = find(name, scope);
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

const dialog = () =>
  document.querySelector<HTMLElement>('[aria-labelledby="lp-title"]');

/** Open the path and press a step's own button, named as its label says. */
function fromPath(label: string): void {
  press(must('Menu'));
  press(must('Learning path'));
  const d = dialog();
  if (!d) throw new Error('no learning path dialog');
  press(must(label, d));
  // The dialog's exit.
  advance(400);
}

const brief = () => document.querySelector<HTMLElement>('section.chal:not(.inc)');
const story = () => document.querySelector<HTMLElement>('section.chal.inc');

function settleCheck(): void {
  for (let i = 0; i < 60; i++) {
    advance(250);
    const chip = document.querySelector('.chal-chip')?.textContent;
    if (chip && chip !== 'Changed' && chip !== 'Not checked yet' && chip !== 'Checking')
      return;
  }
}

/** Select a node on the canvas and type a new value into one of its fields. */
function setField(nodeSelector: string, field: string, value: (n: number) => number) {
  const node = document.querySelector(`[data-hit="node"]${nodeSelector}`);
  if (!node) throw new Error(`no node ${nodeSelector}`);
  press(node);
  const label = [...document.querySelectorAll('.ins label')].find(
    (l) => l.textContent?.trim() === field,
  );
  if (!label) throw new Error(`no field ${field}`);
  const input = document.getElementById(
    label.getAttribute('for') ?? '',
  ) as HTMLInputElement;
  const next = value(Number(input.value));
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      ?.set as (this: HTMLInputElement, v: string) => void;
    set.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Hold the line passes with four more slots on its database. */
function passHoldTheLine(): void {
  setField('[data-kind="db"]', 'Slots per instance', (n) => n + 4);
  settleCheck();
}

const hold = challengeById('hold-the-line')!;
const busy = challengeById('nothing-looks-busy')!;
const [s3, , aws] = INCIDENTS as [
  (typeof INCIDENTS)[number],
  (typeof INCIDENTS)[number],
  (typeof INCIDENTS)[number],
];
const coinbase21 = incidentById('incident-coinbase-2021')!;

function asPhone(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-width: 720px') || query.includes('coarse'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

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
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a challenge step', () => {
  it('opens beside the inspector on a pass, with the lesson and the next step', () => {
    mount();
    fromPath(`Start step 3, ${hold.name}`);
    expect(brief()?.querySelector('.chal-name')?.textContent).toBe(hold.name);

    passHoldTheLine();
    // The inspector is open for the database the pass was made on, and the
    // brief is not folded under it.
    expect(document.querySelector('.ins')).not.toBeNull();
    expect(brief()?.classList.contains('is-collapsed')).toBe(false);
    expect(brief()?.querySelector('.chal-lesson-title')?.textContent).toBe(
      'What you learned',
    );
    expect(brief()?.textContent).toContain(hold.lesson);

    // Path order: the next step, not the picker's next brief.
    const next = must(`Next: ${busy.name}`);
    expect(next.classList.contains('btn-primary')).toBe(true);
    press(next);
    expect(brief()?.querySelector('.chal-name')?.textContent).toBe(busy.name);
  });

  it('folds again when the reader folds it, after the pass opened it', () => {
    mount();
    fromPath(`Start step 3, ${hold.name}`);
    passHoldTheLine();
    press(must('Hide the brief'));
    expect(brief()?.classList.contains('is-collapsed')).toBe(true);
    advance(2000);
    expect(brief()?.classList.contains('is-collapsed')).toBe(true);
  });

  it('says a pass over the phone inspector, and shows it when asked', () => {
    asPhone();
    mount();
    fromPath(`Start step 3, ${hold.name}`);
    expect(find('See what you learned')).toBeNull();
    passHoldTheLine();
    // The settings sheet steps down as the pass lands, so the lesson shows.
    expect(document.querySelector('.app-body.has-inspector')).toBeNull();
    expect(brief()?.textContent).toContain(hold.lesson);
    expect(document.querySelector('.pass-strip')).toBeNull();
    // Tapping the part again brings its settings back, and the strip says
    // the pass over them.
    const db = document.querySelector('[data-hit="node"][data-kind="db"]');
    if (!db) throw new Error('no database on the canvas');
    press(db, 'touch');
    expect(document.querySelector('.pass-strip')?.textContent).toContain(
      `You passed ${hold.name}.`,
    );
    expect(document.querySelector('.app-body.has-inspector')).not.toBeNull();
    press(must('See what you learned'), 'touch');
    // The settings sheet goes, and the brief under it is open.
    expect(document.querySelector('.app-body.has-inspector')).toBeNull();
    expect(document.querySelector('.pass-strip')).toBeNull();
    expect(brief()?.classList.contains('is-collapsed')).toBe(false);
    expect(brief()?.textContent).toContain(hold.lesson);
  });
});

describe('a real outage step', () => {
  it('opens its story with Watch it happen first, then its brief with Fix it', () => {
    mount();
    fromPath(`Start step 43, ${s3.name}`);
    expect(story()?.querySelector('.chal-name')?.textContent).toBe(s3.name);
    expect(must('Watch it happen').classList.contains('btn-primary')).toBe(true);
    expect(must('Fix it').classList.contains('btn-primary')).toBe(false);

    press(must('Watch it happen'));
    advance(200);
    expect(must('Watch again').classList.contains('btn-primary')).toBe(false);
    expect(must('Fix it').classList.contains('btn-primary')).toBe(true);

    // Its row continues the open story rather than starting it over.
    press(must('Menu'));
    press(must('Learning path'));
    press(must(`Continue step 43, ${s3.name}`, dialog()!));
    advance(400);
    expect(story()?.querySelector('.chal-name')?.textContent).toBe(s3.name);

    press(must('Fix it'));
    expect(story()).toBeNull();
    expect(brief()?.querySelector('.chal-name')?.textContent).toBe(s3.brief.name);
  });

  it('opens from inside a brief, putting the reader design back first', () => {
    mount();
    fromPath(`Start step 3, ${hold.name}`);
    expect(brief()).not.toBeNull();
    fromPath(`Start step 43, ${s3.name}`);
    expect(brief()).toBeNull();
    expect(story()?.querySelector('.chal-name')?.textContent).toBe(s3.name);
    const ids = () =>
      [...document.querySelectorAll('[data-hit="node"]')].map((n) =>
        n.getAttribute('data-id'),
      );
    // The story opens its scene over the reader's design, not the brief's,
    // so one undo gives the reader's own design back.
    expect(ids()).toEqual(s3.scene.nodes.map((n) => n.id));
    press(must('Undo'));
    expect(ids()).toEqual(['mine-client', 'mine-svc']);
  });

  it('counts as done when its brief passes, with the lesson and Next to the outage after it', () => {
    mount();
    fromPath(`Start step 45, ${aws.name}`);
    press(must('Fix it'));
    setField('[data-id="callers"]', 'Retries', () => 0);
    settleCheck();
    expect(document.querySelector('.chal-chip')?.textContent).toBe('Passed');
    expect(brief()?.classList.contains('is-collapsed')).toBe(false);
    expect(brief()?.textContent).toContain(aws.brief.lesson);
    // Chronological, so Coinbase 2021 comes after it.
    expect(must(`Next: ${coinbase21.name}`)).toBeTruthy();

    press(must('Menu'));
    press(must('Learning path'));
    const d = dialog()!;
    expect(d.querySelector('.lp-progress')?.textContent).toBe('1 of 48 done');
    const row = find(`Continue step 45, ${aws.name}`, d);
    // On the canvas, so it continues; its badge says it is the one open.
    expect(row).not.toBeNull();
  });
});
