// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector, TrafficControl, type TrafficControlProps } from './Inspector';
import { makeNode } from '../sim/presets';
import type { NodeConfig, SimNode, SystemStats } from '../sim/types';

/**
 * The client's traffic shape and the header's load multiple, driven with the
 * pointer sequence a browser sends: down, up, then the click it synthesizes.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
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

function press(el: Element): void {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Pick an option the way a browser does: press the select, then it changes. */
function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    select.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function labels(): string[] {
  return [...container.querySelectorAll('label')].map(
    (l) => l.textContent?.trim() ?? '',
  );
}

function rowOf(label: string): HTMLElement {
  const el = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === label,
  );
  const row = el?.closest('.ins-field, .ins-field-row');
  if (!(row instanceof HTMLElement)) throw new Error(`no field ${label}`);
  return row;
}

function client(config: Partial<NodeConfig> = {}): SimNode {
  const n = { ...makeNode('client', 0, 0), id: 'c' };
  return { ...n, config: { ...n.config, ...config } };
}

function render(node: SimNode, onChange = vi.fn()) {
  act(() =>
    root.render(
      <Inspector
        node={node}
        stats={null}
        onChange={onChange}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
  return onChange;
}

describe('traffic shape', () => {
  it('reads steady on a client that never set one, with no cycle to set', () => {
    render(client());
    const select = rowOf('Traffic shape').querySelector('select');
    expect(select?.value).toBe('steady');
    expect(rowOf('Traffic shape').textContent).toContain(
      'The same rate the whole time.',
    );
    expect(labels()).not.toContain('Cycle length');
    expect(labels()).not.toContain('Callers in the herd');
  });

  it('writes the shape that was picked', () => {
    const onChange = render(client());
    const select = rowOf('Traffic shape').querySelector('select');
    if (!select) throw new Error('no select');
    choose(select, 'herd');
    expect(onChange).toHaveBeenCalledWith('c', { traffic: 'herd' });
  });

  it('shows a herd its cycle, size and spread, in its own terms', () => {
    render(client({ traffic: 'herd', rps: 50 }));
    expect(rowOf('Traffic shape').textContent).toContain(
      'Once a cycle, a herd of callers piles in on top of the normal rate.',
    );
    expect(rowOf('Cycle length').querySelector('input')?.value).toBe('60');
    expect(rowOf('Cycle length').textContent).toContain(
      'Time from one herd to the next.',
    );
    expect(rowOf('Callers in the herd').querySelector('input')?.value).toBe('500');
    expect(rowOf('Callers in the herd').textContent).toContain(
      'That is 10 seconds of normal traffic arriving in one instant.',
    );
    expect(rowOf('Spread the herd over').textContent).toContain('all at once');
    expect(labels()).not.toContain('Average clump');
  });

  it('stops saying one instant once the herd is spread', () => {
    render(client({ traffic: 'herd', rps: 50, herdSpreadMs: 3000 }));
    const size = rowOf('Callers in the herd').textContent ?? '';
    expect(size).toContain('each cycle');
    expect(size).toContain('That is 10 seconds of normal traffic arriving within 3');
    expect(container.textContent).not.toContain('instant');
  });

  it('shows bursty its clump size and nothing a herd reads', () => {
    render(client({ traffic: 'bursty' }));
    expect(rowOf('Average clump').textContent).toContain('10 at once');
    expect(labels()).not.toContain('Cycle length');
    expect(labels()).not.toContain('Spread the herd over');
  });

  it('marks a selection of clients on different shapes as mixed', () => {
    const onChangeMany = vi.fn();
    const a = client({ traffic: 'steady' });
    const b = { ...client({ traffic: 'herd' }), id: 'd' };
    act(() =>
      root.render(
        <Inspector
          node={a}
          selectedNodes={[a, b]}
          stats={null}
          onChange={() => {}}
          onChangeMany={onChangeMany}
          onDelete={() => {}}
          onRename={() => {}}
        />,
      ),
    );
    const select = rowOf('Traffic shape').querySelector('select')!;
    expect(select.hasAttribute('data-mixed')).toBe(true);
    expect(select.selectedOptions[0]?.textContent).toBe('mixed');
    choose(select, 'spike');
    expect(onChangeMany).toHaveBeenCalledWith(['c', 'd'], { traffic: 'spike' });
  });

  it('says a spike averages about half', () => {
    render(client({ traffic: 'spike' }));
    expect(rowOf('Traffic shape').textContent).toContain(
      'The average is about half the offered load.',
    );
  });
});

const SYSTEM: SystemStats = {
  timeMs: 0,
  offeredRps: 0,
  goodputRps: 0,
  errorRate: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  totalRequests: 0,
  totalFailed: 0,
};

function header(props: Partial<TrafficControlProps>) {
  const base: TrafficControlProps = {
    rps: 100,
    onRpsChange: () => {},
    running: true,
    onToggleRun: () => {},
    onStep: () => {},
    onReset: () => {},
    system: SYSTEM,
    lost: 0,
    empty: false,
    noTrafficSource: false,
  };
  act(() => root.render(<TrafficControl {...base} {...props} />));
}

function button(text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
  if (!b) throw new Error(`no button ${text}`);
  return b;
}

describe('load as a multiple', () => {
  it('reads the rate against the 1x and jumps to a multiple', () => {
    const onRpsChange = vi.fn();
    header({ rps: 100, baselineRps: 50, onRpsChange });
    const chip = button('2.0x');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    press(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('1x is 50/s, the rate these multiples');
    expect(chip.getAttribute('aria-label')).toBe('Load is 2.0x, where 1x is 50/s');
    expect(button('2x').getAttribute('aria-pressed')).toBe('true');
    press(button('4x'));
    expect(onRpsChange).toHaveBeenCalledWith(200);
  });

  it('makes the current rate the new 1x and closes', () => {
    const onMakeBaseline = vi.fn();
    header({ rps: 100, baselineRps: 50, onMakeBaseline });
    press(button('2.0x'));
    press(button('Make 100/s the new 1x'));
    expect(onMakeBaseline).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.traffic-multiple-panel')).toBeNull();
  });

  it('cannot make 1x the 1x again, or go past the slider', () => {
    header({ rps: 2000, baselineRps: 2000, onMakeBaseline: () => {} });
    press(button('1.0x'));
    expect(button('Make 2k/s the new 1x').disabled).toBe(true);
    expect(button('4x').disabled).toBe(true);
  });

  it('closes on a press outside, and on Escape', () => {
    header({ rps: 100, baselineRps: 50 });
    press(button('2.0x'));
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.traffic-multiple-panel')).toBeNull();
    press(button('2.0x'));
    act(() => {
      button('1x').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(container.querySelector('.traffic-multiple-panel')).toBeNull();
  });

  it('is only a reading while a challenge holds the load', () => {
    header({ rps: 100, baselineRps: 50, locked: true });
    expect(container.querySelector('button.traffic-multiple')).toBeNull();
    expect(container.querySelector('.traffic-multiple')?.textContent).toBe('2.0x');
  });

  it('says what is really arriving while a shape is on', () => {
    header({ rps: 50, baselineRps: 50, liveRps: 613 });
    // The word "base" travels with the live figure, so it survives the
    // widths that hide the unit.
    expect(container.querySelector('.traffic-load-now')?.textContent).toBe(
      'base, now 613/s',
    );
    header({ rps: 50, baselineRps: 50, liveRps: null });
    expect(container.querySelector('.traffic-load-now')).toBeNull();
  });
});
