// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NodeView } from './Canvas';
import { glanceScale } from './glance';
import { makeNode } from '../sim/presets';
import type { FailureKind, NodeStats } from '../sim/types';
import type { Health } from './format';

/**
 * The glance line replaces the card's header on a touch screen zoomed out
 * past DETAIL_ZOOM, but the status mark must survive it. The mark is the
 * shape channel for health (ring, disc, square), and without it a phone at
 * fit zoom told warn from danger by colour alone.
 */

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
});

function stats(): NodeStats {
  return {
    inFlight: 1,
    queued: 0,
    throughput: 100,
    arrivalRate: 100,
    utilization: 0.8,
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

function draw(opts: {
  glance: number;
  health?: Health;
  fault?: FailureKind | null;
}): void {
  act(() =>
    root.render(
      <svg>
        <NodeView
          node={makeNode('service', 0, 0)}
          stats={stats()}
          spark={undefined}
          selected={false}
          detail={1}
          linkRole="none"
          linking={false}
          linkTarget={false}
          fault={opts.fault ?? null}
          backlog={0}
          route={null}
          settledHealth={opts.health}
          glance={opts.glance}
          onActivate={() => {}}
          onNudge={() => {}}
          entering={false}
        />
      </svg>,
    ),
  );
}

const glance = glanceScale(0.6, true);

describe('status marks under the glance line', () => {
  it('draws the glance line at 0.6 on a coarse pointer', () => {
    expect(glance).toBeGreaterThan(0);
  });

  it('keeps the warn ring', () => {
    draw({ glance, health: 'warn' });
    expect(container.querySelector('.cv-node-mark.is-warn')).not.toBeNull();
  });

  it('keeps the danger disc', () => {
    draw({ glance, health: 'danger' });
    expect(container.querySelector('.cv-node-mark.is-danger')).not.toBeNull();
  });

  it('keeps the fault square', () => {
    draw({ glance, fault: 'crash' });
    expect(container.querySelector('.cv-node-mark.is-fault')).not.toBeNull();
  });

  it('draws the mark at the same screen size as without the glance line', () => {
    draw({ glance, health: 'danger' });
    const r = Number(container.querySelector('.cv-node-mark')!.getAttribute('r'));
    draw({ glance: 0, health: 'danger' });
    const r0 = Number(container.querySelector('.cv-node-mark')!.getAttribute('r'));
    expect(r).toBeCloseTo(r0 * glance);
  });

  it('draws no mark on a healthy node', () => {
    draw({ glance, health: 'ok' });
    expect(container.querySelector('.cv-node-mark')).toBeNull();
  });
});
