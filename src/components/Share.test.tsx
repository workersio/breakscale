// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Share, type ShareKind, type ShareResult } from './Share';
import { setEndpointForTests } from '../share/store';

/* ------------------------------------------------------------------ *
 * The share dialog with and without a run worth replaying. Without one
 * there is a single option; with one, two side by side, each building,
 * copying and failing on its own.
 * ------------------------------------------------------------------ */

class FakePointerEvent extends MouseEvent {
  pointerId = 1;
  pointerType = 'mouse';
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** pointerdown, mousedown, pointerup, mouseup, click, as a browser sends them. */
function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', at));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
  });
}

function buttons(): string[] {
  return Array.from(document.querySelectorAll('.sh-card button'))
    .map((b) => b.textContent ?? '')
    .filter((t) => t !== '');
}

function option(title: string): HTMLElement {
  const o = Array.from(document.querySelectorAll<HTMLElement>('.sh-option')).find(
    (x) => x.querySelector('h3')?.textContent === title,
  );
  if (!o) throw new Error(`no option ${title}`);
  return o;
}

function titles(): string[] {
  return Array.from(document.querySelectorAll('.sh-option h3')).map(
    (h) => h.textContent ?? '',
  );
}

function copyButton(title: string): HTMLButtonElement {
  const b = option(title).querySelector<HTMLButtonElement>('.sh-copy');
  if (!b) throw new Error(`no copy button in ${title}`);
  return b;
}

function status(): string {
  return document.querySelector('[role="status"]')?.textContent ?? '';
}

/** Let every pending promise and the state it sets land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let clipboard: string[];
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clipboard = [];
  writeText = vi.fn((t: string) => {
    clipboard.push(t);
    return Promise.resolve();
  });
  // jsdom has no clipboard and no ClipboardItem, which is the fallback
  // path: write once the link is in hand.
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
});

function render(
  onBuild: (kind: ShareKind) => Promise<ShareResult>,
  replayable: boolean,
) {
  act(() =>
    root.render(
      <Share
        open
        onClose={() => {}}
        onBuild={onBuild}
        replayable={replayable}
        onExport={() => {}}
      />,
    ),
  );
}

const urlFor = (kind: ShareKind) => `https://breakscale.tech/?d=${kind}#k`;
const ok = (kind: ShareKind): Promise<ShareResult> =>
  Promise.resolve({ ok: true, url: urlFor(kind) });

describe('Share', () => {
  it('offers the design alone when the run has no faults', () => {
    render(vi.fn(ok), false);
    expect(document.querySelector('#sh-title')?.textContent).toBe('Share');
    expect(titles()).toEqual(['This design']);
    expect(buttons()).toEqual(['Copy link', 'Save to a file']);
    expect(document.body.textContent).not.toContain('fault');
  });

  it('offers this exact run beside the design once the run has faults', () => {
    render(vi.fn(ok), true);
    expect(titles()).toEqual(['This design', 'This exact run']);
    expect(option('This design').textContent).toContain('runs fresh from the start');
    expect(option('This exact run').textContent).toContain(
      'each fault at the moment it happened',
    );
    // Opening is not consent to upload anything.
    expect(document.querySelector('.sh-url')).toBeNull();
  });

  it('builds and copies in one click, and says so', async () => {
    const onBuild = vi.fn(ok);
    render(onBuild, true);
    press(copyButton('This exact run'));
    await settle();
    expect(onBuild).toHaveBeenCalledWith('run');
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(clipboard).toEqual([urlFor('run')]);
    expect(copyButton('This exact run').textContent).toBe('Copied');
    expect(copyButton('This exact run').querySelector('svg')).not.toBeNull();
    expect(status()).toBe('Link copied');
    const field = option('This exact run').querySelector<HTMLInputElement>('.sh-url');
    expect(field?.value).toBe(urlFor('run'));
    expect(field?.getAttribute('aria-label')).toBe('Link to this exact run');
  });

  it('says it is making the link while the store is busy', async () => {
    const pending = deferred<ShareResult>();
    const onBuild = vi.fn(() => pending.promise);
    render(onBuild, false);
    press(copyButton('This design'));
    expect(copyButton('This design').textContent).toBe('Making link…');
    expect(copyButton('This design').getAttribute('aria-disabled')).toBe('true');
    // A second press while it works builds nothing more.
    press(copyButton('This design'));
    expect(onBuild).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, url: urlFor('design') });
    await settle();
    expect(copyButton('This design').textContent).toBe('Copied');
  });

  it('copying one link leaves the other usable, and each keeps its own', async () => {
    const onBuild = vi.fn(ok);
    render(onBuild, true);
    press(copyButton('This design'));
    await settle();
    press(copyButton('This exact run'));
    await settle();
    expect(clipboard).toEqual([urlFor('design'), urlFor('run')]);
    // Both fields stay; only the one in the clipboard reads Copied.
    expect(document.querySelectorAll('.sh-url')).toHaveLength(2);
    expect(copyButton('This design').textContent).toBe('Copy link');
    expect(copyButton('This exact run').textContent).toBe('Copied');
    // Copying the design again reuses its link: no second store write.
    press(copyButton('This design'));
    await settle();
    expect(onBuild).toHaveBeenCalledTimes(2);
    expect(clipboard.at(-1)).toBe(urlFor('design'));
    expect(copyButton('This design').textContent).toBe('Copied');
  });

  it('retries the link that failed, and only that one', async () => {
    const onBuild = vi.fn((kind: ShareKind): Promise<ShareResult> =>
      Promise.resolve({ ok: false, message: `no ${kind}` }),
    );
    render(onBuild, true);
    press(copyButton('This exact run'));
    await settle();
    expect(option('This exact run').textContent).toContain('no run');
    expect(status()).toBe('no run');
    expect(clipboard).toEqual([]);
    expect(copyButton('This exact run').textContent).toBe('Try again');
    expect(copyButton('This design').textContent).toBe('Copy link');
    press(copyButton('This exact run'));
    await settle();
    expect(onBuild.mock.calls.map((c) => c[0])).toEqual(['run', 'run']);
  });

  it('leaves the link selected in its field when the clipboard refuses', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    render(vi.fn(ok), false);
    press(copyButton('This design'));
    await settle();
    expect(copyButton('This design').textContent).toBe('Copy link');
    expect(status()).toBe('Link ready. Copy it from the field.');
    expect(
      option('This design').querySelector<HTMLInputElement>('.sh-url')?.value,
    ).toBe(urlFor('design'));
  });

  it('starts the clipboard write inside the click where the browser allows it', async () => {
    // Safari drops the click's permission across an await, so the write
    // has to begin before the store answers, with the link as a promise.
    const write = vi.fn(async (items: { getType: (t: string) => Promise<Blob> }[]) => {
      clipboard.push(await (await items[0]!.getType('text/plain')).text());
    });
    class FakeItem {
      private readonly data: Record<string, Promise<Blob>>;
      constructor(data: Record<string, Promise<Blob>>) {
        this.data = data;
      }
      getType(t: string): Promise<Blob> {
        // Always present: the dialog writes text/plain and nothing else.
        return this.data[t]!;
      }
    }
    vi.stubGlobal('ClipboardItem', FakeItem);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write, writeText } });
    const pending = deferred<ShareResult>();
    render(() => pending.promise, false);
    press(copyButton('This design'));
    expect(write).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, url: urlFor('design') });
    await settle();
    expect(clipboard).toEqual([urlFor('design')]);
    expect(writeText).not.toHaveBeenCalled();
    expect(copyButton('This design').textContent).toBe('Copied');
  });

  it('only promises encryption when there is a store to encrypt for', () => {
    const note = () => document.querySelector('.sh-foot .sh-note')?.textContent;
    setEndpointForTests('');
    render(vi.fn(ok), false);
    expect(note()).toBe('The design travels inside the link itself.');
    act(() => root.unmount());
    root = createRoot(container);
    setEndpointForTests('https://links.example');
    try {
      render(vi.fn(ok), false);
      expect(note()).toBe(
        'Encrypted in your browser before it is stored. The store cannot read it.',
      );
    } finally {
      setEndpointForTests(null);
    }
  });
});
