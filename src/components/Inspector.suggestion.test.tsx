// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { KIND_NAME } from './nodeVisuals';
import { makeNode } from '../sim/presets';
import { suggestionFor } from '../content/suggestions';
import type { NodeKind, NodeStats } from '../sim/types';

/**
 * The suggestion is gated on headroom, and headroom is derived inside the
 * component from stats the engine produces. A unit test on suggestionFor can
 * only prove the strings; it cannot prove a node ever shows one, nor that a
 * healthy node stays quiet. These render the real panel and read the DOM.
 *
 * Every kind is driven from KIND_NAME rather than a list copied out of
 * Inspector.tsx. A copied list rots silently: add a kind to
 * HAS_THROUGHPUT_CEILING with no suggestion written for it and a hardcoded
 * list would never mention it. Here the ceiling readout and the suggestion
 * are asserted to appear together, so that case fails.
 */
const ALL_KINDS = Object.keys(KIND_NAME) as NodeKind[];

/** Above every default ceiling, so any kind that has one is past it. The
 *  load balancer sets that bar: 256 slots at 0.5ms is 512k/s. */
const OVERLOADED = 2_000_000;

/** Only the fields NodeStats requires; the panels read the rest as optional. */
function statsWith(arrivalRate: number): NodeStats {
  return {
    inFlight: 1,
    queued: 0,
    throughput: arrivalRate,
    arrivalRate,
    utilization: 0.99,
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
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React only accepts act() from an environment that declares itself one.
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
});

function renderKind(kind: NodeKind, arrivalRate: number): void {
  act(() =>
    root.render(
      <Inspector
        node={makeNode(kind, 0, 0)}
        stats={statsWith(arrivalRate)}
        onChange={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
}

/** The rendered suggestion, or null when the section is absent. */
function suggestion(): string | null {
  return document.querySelector('.ins-suggestion')?.textContent?.trim() ?? null;
}

/** Whether the panel is showing a headroom reading at all. */
function showsHeadroom(): boolean {
  return (document.body.textContent ?? '').includes('Can keep up with');
}

describe('the suggested fix in the inspector', () => {
  it.each(ALL_KINDS)(
    'gives %s a suggestion exactly when it reads out headroom',
    (kind) => {
      renderKind(kind, OVERLOADED);
      // Headroom is what the suggestion is gated on, so the two have to agree.
      // Either the panel says this node is past its ceiling and offers a fix,
      // or it says neither.
      expect(suggestion() === null).toBe(!showsHeadroom());
    },
  );

  it.each(ALL_KINDS)('gives %s the text its kind defines', (kind) => {
    renderKind(kind, OVERLOADED);
    if (showsHeadroom()) expect(suggestion()).toBe(suggestionFor(kind));
  });

  it.each(ALL_KINDS)('stays quiet for %s while it has headroom', (kind) => {
    // One request a second is under every default ceiling, the 2/s transcoder
    // and the 9/s cold storage included.
    renderKind(kind, 1);
    expect(suggestion()).toBeNull();
  });

  it('stays quiet when nothing is arriving, rather than reading 0 as overloaded', () => {
    // Headroom is null at zero arrivals. Treating that as "below 1.0x" would
    // tell a student to fix a node that is merely idle.
    renderKind('service', 0);
    expect(suggestion()).toBeNull();
  });

  it('does not tell an overloaded database to get bigger', () => {
    // The one suggestion the issue thread singles out as a trap.
    renderKind('db', OVERLOADED);
    expect(suggestion()).not.toMatch(/add (more )?(capacity|instances)/i);
  });
});
