// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { incidentById } from './sim/incidents';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * A real incident from the examples dialog: its panel, the replay with its
 * captions as one undo step, and Fix it handing over to the challenge panel
 * with Leave putting the reader's design back.
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

function must(name: string): HTMLElement {
  const el = [
    ...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]'),
  ].find(
    (b) =>
      b.getAttribute('aria-label') === name ||
      b.textContent?.trim() === name ||
      b.querySelector('.ex-item-name')?.textContent === name,
  );
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

const panel = () => document.querySelector('section.chal');
/** The caption as read: its time, then its words. */
const caption = () => {
  const el = document.querySelector('.inc-caption');
  if (!el) return null;
  const at = el.querySelector('.inc-caption-at')?.textContent;
  const text = el.querySelector('.inc-caption-text')?.textContent;
  return at && text ? `${at}: ${text}` : el.textContent;
};
const canvasIds = () =>
  [...document.querySelectorAll('[data-hit="node"]')].map((n) =>
    n.getAttribute('data-id'),
  );

const s3 = incidentById('incident-s3-2017')!;
const coinbase = incidentById('incident-coinbase-2026')!;
const coinbase21 = incidentById('incident-coinbase-2021')!;
const discord = incidentById('incident-discord-2023')!;

function openIncident(): void {
  press(must('Menu'));
  press(must('Examples'));
  press(must(s3.name));
  advance(400);
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

describe('a real incident', () => {
  it('opens from the examples dialog with its story and source', () => {
    mount();
    openIncident();
    const p = panel();
    expect(p?.textContent).toContain(s3.name);
    expect(p?.textContent).toContain('A simplified model.');
    const link = p?.querySelector<HTMLAnchorElement>('.inc-source a');
    expect(link?.href).toBe(s3.source.url);
    expect(link?.textContent).toBe(s3.source.title);
    expect(document.activeElement).toBe(p?.querySelector('h2'));
  });

  it('puts its scene on the canvas, paused at the start, as one undo step', () => {
    mount();
    openIncident();
    expect(canvasIds()).toEqual(s3.scene.nodes.map((n) => n.id));
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      `Opened ${s3.name}. Undo brings your design back.`,
    );
    // Paused: nothing has happened yet, so there is no caption to show.
    advance(3000);
    expect(caption()).toBeNull();
    expect(must('Watch it happen')).not.toBeNull();
    press(must('Undo'));
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
  });

  it('gives the run back its play state when closed without watching', () => {
    mount();
    expect(must('Pause')).not.toBeNull();
    openIncident();
    expect(must('Play')).not.toBeNull();
    press(must('Close'));
    expect(must('Pause')).not.toBeNull();
  });

  it('plays the scene with captions, and one undo puts the design back', () => {
    mount();
    openIncident();
    expect(caption()).toBeNull();
    press(must('Watch it happen'));
    expect(canvasIds()).toEqual(s3.scene.nodes.map((n) => n.id));
    expect(caption()).toBe(`0s: ${s3.captions[0]!.text}`);
    advance(21_000);
    expect(caption()).toBe(`20s: ${s3.captions[1]!.text}`);

    // Watching the scene opening installed is not a second step to undo.
    press(must('Undo'));
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    // Not the scene any more, so no caption.
    expect(caption()).toBeNull();
  });

  it('hands Fix it to the challenge panel, and Leave restores the design', () => {
    mount();
    openIncident();
    press(must('Fix it'));
    expect(panel()?.textContent).toContain(s3.brief.name);
    expect(panel()?.textContent).toContain(s3.brief.brief);
    expect(canvasIds()).toEqual(s3.scene.nodes.map((n) => n.id));
    press(must('Back to my design'));
    expect(panel()).toBeNull();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
  });

  it('reads the first check of Fix it as the problem, before the outage', () => {
    mount();
    openIncident();
    press(must('Fix it'));
    for (let i = 0; i < 80; i++) {
      advance(250);
      if (document.querySelector('.chal-verdict:not(.is-pending)')) break;
    }
    const verdict = document.querySelector('.chal-verdict');
    expect(verdict?.className).toContain('is-base');
    expect(verdict?.className).not.toContain('is-danger');
    expect(verdict?.textContent).toMatch(
      /^As it starts\. When S3, one region, goes down at 20s, \d+(\.\d+)?% of requests from /,
    );
    // The live run has not reached the outage yet, and says how long it has.
    // It is running: opening paused the scene for Watch, not for the brief.
    advance(2000);
    const left = /^Outage in (\d+)s$/.exec(
      document.querySelector('.chal-countdown')?.textContent ?? '',
    );
    expect(left).not.toBeNull();
    expect(Number(left![1])).toBeLessThan(20);
    expect(panel()?.textContent).toContain('In the 3 test runs (15s to 60s)');
  });

  it("sets aside the reader's own design, not the scene, after watching it", () => {
    mount();
    openIncident();
    press(must('Watch it happen'));
    advance(1000);
    press(must('Fix it'));
    press(must('Back to my design'));
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
  });

  it('announces the first caption from a live region that was already there', () => {
    mount();
    openIncident();
    const live = panel()?.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('');
    press(must('Watch it happen'));
    expect(panel()?.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live?.textContent).toBe(`0s: ${s3.captions[0]!.text}`);
  });
});

describe('finding the incidents in the examples dialog', () => {
  function search(text: string): void {
    const input = document.querySelector<HTMLInputElement>('.ex-search')!;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const incidentNames = () =>
    [...document.querySelectorAll('.inc-section .ex-item-name')].map(
      (n) => n.textContent,
    );

  it('finds every incident by the section name, and one by its year', () => {
    mount();
    press(must('Menu'));
    press(must('Examples'));
    search('incident');
    expect(incidentNames()).toHaveLength(6);
    search('2017');
    expect(incidentNames()).toEqual([s3.name]);
  });

  it('finds the Coinbase outage by the company, and opens its brief', () => {
    mount();
    press(must('Menu'));
    press(must('Examples'));
    search('coinbase');
    expect(incidentNames()).toEqual([coinbase.name, coinbase21.name]);
    press(must(coinbase.name));
    advance(400);
    expect(panel()?.textContent).toContain(coinbase.simNote);
    press(must('Fix it'));
    expect(panel()?.textContent).toContain(coinbase.brief.brief);
    expect(canvasIds()).toEqual(coinbase.scene.nodes.map((n) => n.id));
  });

  it.each([
    ['discord', () => discord],
    ['memcached', () => coinbase21],
  ])('finds %s and opens its brief on its own scene', (q, which) => {
    const i = which();
    mount();
    press(must('Menu'));
    press(must('Examples'));
    search(q);
    expect(incidentNames()).toEqual([i.name]);
    press(must(i.name));
    advance(400);
    expect(panel()?.textContent).toContain(i.simNote);
    press(must('Fix it'));
    expect(panel()?.textContent).toContain(i.brief.brief);
    expect(canvasIds()).toEqual(i.scene.nodes.map((n) => n.id));
  });

  it('jumps from the header to the first incident, clearing a search', () => {
    mount();
    press(must('Menu'));
    press(must('Examples'));
    search('cache');
    Element.prototype.scrollIntoView ??= () => {};
    press(must('Incidents'));
    expect(incidentNames()).toHaveLength(6);
    expect(document.activeElement?.querySelector('.ex-item-name')?.textContent).toBe(
      incidentNames()[0],
    );
  });
});
