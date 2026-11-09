// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { makeNode } from '../sim/presets';
import { GLOSSARY_BY_ID } from '../content/glossary';
import { __resetPreferences, setPreference } from '../content/preferences';
import type { NodeKind, NodeStats } from '../sim/types';

/**
 * The inspector's "On the diagram" key: the words printed on the selected
 * node's box, each with its glossary definition. Rendered for real and read
 * off the DOM, because the point is that the words match the box and the
 * definitions come from the glossary rather than a second copy.
 */

function stats(over: Partial<NodeStats> = {}): NodeStats {
  return {
    inFlight: 6,
    queued: 34,
    throughput: 200,
    arrivalRate: 212,
    utilization: 1,
    errorRate: 0,
    shedRate: 0,
    timeoutRate: 0,
    hitRate: 0.8,
    totalCompleted: 0,
    totalFailed: 0,
    p50: 10,
    p95: 20,
    p99: 30,
    queueLimit: 256,
    staleReadRate: 0,
    maxShardUtilization: 0,
    minShardUtilization: 0,
    shardUtilization: [],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  __resetPreferences();
});

function render(kind: NodeKind, s: NodeStats = stats()): void {
  act(() =>
    root.render(
      <Inspector
        node={makeNode(kind, 0, 0)}
        stats={s}
        onChange={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
}

function rows(): [string, string][] {
  return [...container.querySelectorAll('.ins-box-key-row')].map((row) => [
    row.querySelector('dt')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);
}

describe('the on-the-diagram key', () => {
  it('defines the three words on a database box from the glossary', () => {
    render('db');
    expect(container.querySelector('.ins-box-key .label')?.textContent).toBe(
      'On the diagram',
    );
    expect(rows()).toEqual([
      ['busy', GLOSSARY_BY_ID.get('utilisation')?.short],
      ['p99', GLOSSARY_BY_ID.get('p99')?.short],
      ['waiting', GLOSSARY_BY_ID.get('backlog')?.short],
    ]);
  });

  it('makes each word a term with its own explanation', () => {
    setPreference('tooltips', true);
    render('db');
    const ids = [...container.querySelectorAll('.ins-box-key [data-term]')].map(
      (el) => (el as HTMLElement).dataset.term,
    );
    expect(ids).toEqual(['utilisation', 'p99', 'backlog']);
  });

  it('keeps the definitions when hover explanations are off', () => {
    // The definition is plain text, so it reads without a hover or a tap.
    setPreference('tooltips', false);
    render('db');
    expect(rows()).toHaveLength(3);
    expect(container.querySelector('.ins-box-key [data-term]')).toBeNull();
  });

  it('follows the box when a word changes with the state', () => {
    // A rate limiter's headline is what it refused, which is throttling.
    render('ratelimiter', stats({ throttledRate: 40, tokens: 0 }));
    expect(rows()[0]).toEqual(['refused', GLOSSARY_BY_ID.get('throttled')?.short]);
  });

  it('defines waiting on calls in the stats', () => {
    setPreference('tooltips', true);
    render('service', stats({ waitingOnDownstream: 37 }));
    expect(container.querySelector('[data-term="waiting-on-calls"]')?.textContent).toBe(
      'Waiting on its calls',
    );
  });
});
