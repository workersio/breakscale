// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas, { readoutFor } from './Canvas';
import { Engine } from '../sim/engine';
import { makeNode } from '../sim/presets';
import type { RouteStats, SimNode, SimSnapshot, Topology } from '../sim/types';

/*
 * A client card reads as the people behind that client see the system: the
 * p99 and the share failing of its own requests, end to end, once they are
 * settling. Idle, it says so instead of printing a percentage of nothing.
 */

const FRAME = 1000 / 60;

function shop(): Topology {
  const mk = (kind: SimNode['kind'], id: string, label: string): SimNode => ({
    ...makeNode(kind, 0, 0),
    id,
    label,
  });
  const checkout = mk('client', 'checkout', 'Checkout users');
  checkout.config = { ...checkout.config, rps: 40, timeoutMs: 300, retries: 0 };
  checkout.x = 0;
  checkout.y = 0;
  const browse = mk('client', 'browse', 'Browsers');
  browse.config = { ...browse.config, rps: 60, timeoutMs: 300, retries: 0 };
  browse.x = 0;
  browse.y = 200;
  const pay = mk('service', 'pay', 'Payments');
  pay.config = {
    ...pay.config,
    serviceMs: 20,
    serviceCv: 0,
    capacity: 64,
    errorRate: 0,
  };
  pay.x = 300;
  const catalog = mk('service', 'catalog', 'Catalog');
  catalog.config = {
    ...catalog.config,
    serviceMs: 10,
    serviceCv: 0,
    capacity: 64,
    errorRate: 0,
  };
  catalog.x = 300;
  catalog.y = 200;
  return {
    nodes: [checkout, browse, pay, catalog],
    edges: [
      { id: 'checkout->pay', from: 'checkout', to: 'pay', weight: 1 },
      { id: 'browse->catalog', from: 'browse', to: 'catalog', weight: 1 },
    ],
  };
}

function played(): { topology: Topology; snapshot: SimSnapshot; routes: RouteStats[] } {
  const topology = shop();
  const engine = new Engine(topology, 3);
  for (let t = 0; t < 4000; t += FRAME) engine.advance(FRAME);
  engine.injectFailure('pay', 'slow', { factor: 20 });
  for (let t = 0; t < 6000; t += FRAME) engine.advance(FRAME);
  return { topology, snapshot: engine.snapshot(), routes: engine.routes() };
}

describe('the client card', () => {
  it('shows its own route: p99 and share failing', () => {
    const { topology, snapshot, routes } = played();
    const node = topology.nodes[0];
    const checkout = routes.find((r) => r.clientId === 'checkout') ?? null;
    const browse = routes.find((r) => r.clientId === 'browse') ?? null;

    const hurt = readoutFor(
      'client',
      snapshot.nodes.checkout,
      node.config,
      0,
      checkout,
    );
    // Every request times out, so nothing succeeds and there is no p99.
    expect(hurt.a).toEqual({ value: '0/s', label: 'ok' });
    expect(hurt.b).toEqual({ value: '100%', label: 'failing' });
    expect(hurt.health).toBe('danger');

    const fine = readoutFor('client', snapshot.nodes.browse, node.config, 0, browse);
    expect(fine.a).toEqual({ value: '10ms', label: 'p99' });
    expect(fine.b).toEqual({ value: '0%', label: 'failing' });
    expect(fine.health).toBe('ok');
  });

  it('says idle instead of a percentage of nothing', () => {
    const topology = shop();
    for (const n of topology.nodes) if (n.kind === 'client') n.config.rps = 0;
    const engine = new Engine(topology, 1);
    for (let t = 0; t < 2000; t += FRAME) engine.advance(FRAME);
    const [route] = engine.routes();
    const r = readoutFor(
      'client',
      engine.snapshot().nodes.checkout,
      topology.nodes[0].config,
      0,
      route,
    );
    expect(r.b).toEqual({ value: 'idle', label: '' });
    expect(r.losing).toBe(false);
  });

  describe('on the canvas', () => {
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
    });

    it('renders the route figures on each client card', () => {
      const { topology, snapshot, routes } = played();
      act(() =>
        root.render(
          <Canvas
            topology={topology}
            snapshot={snapshot}
            routes={routes}
            selectedIds={new Set()}
            onSelectionChange={() => {}}
            onMoveNode={() => {}}
            onConnect={() => {}}
            onDeleteSelection={() => {}}
            onDropNode={() => {}}
          />,
        ),
      );
      const card = (id: string) =>
        container
          .querySelector(`g[data-hit="node"][data-id="${id}"]`)
          ?.closest('g.cv-node')?.textContent ?? '';
      expect(card('checkout')).toContain('100%');
      expect(card('checkout')).toContain('failing');
      expect(card('browse')).toContain('10ms');
      expect(card('browse')).toContain('p99');
    });
  });
});
