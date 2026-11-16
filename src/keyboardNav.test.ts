// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cycleRegion, regionOf } from './keyboardNav';

afterEach(() => {
  document.body.innerHTML = '';
});

function page(card: string) {
  document.body.innerHTML = `
    <header class="app-bar"><button id="bar">Bar</button></header>
    <main class="app-stage"><div class="stage-canvas" id="diagram" tabindex="-1">
      <svg><g class="cv-node" tabindex="0" id="node"></g></svg>
      ${card}
    </div></main>
    <div class="app-slot-right"><input id="field"></div>`;
}

describe('F6', () => {
  it('stops at the card that guides the work, between the diagram and the panels', () => {
    page(
      '<section class="card-float task-card" tabindex="-1" id="card"><button>Hide</button></section>',
    );
    document.getElementById('node')!.focus();
    expect(cycleRegion(1)).toBe(2);
    expect(document.activeElement?.id).toBe('card');
    expect(regionOf(document.activeElement)).toBe(2);
    cycleRegion(1);
    expect(document.activeElement?.id).toBe('field');
    cycleRegion(-1);
    expect(document.activeElement?.id).toBe('card');
  });

  it('passes over the card when none is open', () => {
    page('');
    document.getElementById('node')!.focus();
    cycleRegion(1);
    expect(document.activeElement?.id).toBe('field');
  });
});
