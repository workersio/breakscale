import { describe, expect, it, vi } from 'vitest';
import {
  buildCommands,
  inSentence,
  type CommandActions,
  type CommandFacts,
} from './appCommands';
import { rankCommands } from './commands';

const facts = (over: Partial<CommandFacts> = {}): CommandFacts => ({
  running: true,
  speed: 1,
  canUndo: false,
  canRedo: false,
  empty: false,
  inChallenge: false,
  breakBlocked: null,
  canPin: true,
  pinned: false,
  libraryOpen: true,
  metricsOpen: false,
  snapToGrid: true,
  theme: 'system',
  presenting: false,
  canFullscreen: true,
  fullscreen: false,
  parts: [
    { id: 'api', label: 'API Server', fault: null, canSlow: true },
    { id: 'db', label: 'Database', fault: 'crash', canSlow: true },
    { id: 'client', label: 'Client', fault: null, canSlow: false },
  ],
  selectedId: 'api',
  kinds: [{ kind: 'lb', name: 'Load balancer', group: 'Traffic' }],
  examples: [{ id: 'netflix', name: 'Netflix: streaming at scale', tagline: 'Video' }],
  challenges: [{ id: 'hold-the-line', name: 'Hold the line' }],
  incidents: [{ id: 's3', name: 'S3 goes down in one region' }],
  glossary: [{ id: 'p99', term: 'p99' }],
  mac: false,
  coarse: false,
  ...over,
});

const actions = (): CommandActions => {
  const fn = () => vi.fn();
  return {
    toggleRun: fn(),
    step: fn(),
    reset: fn(),
    setSpeed: fn(),
    undo: fn(),
    redo: fn(),
    add: fn(),
    openExample: fn(),
    startChallenge: fn(),
    openIncident: fn(),
    crash: fn(),
    slow: fn(),
    fix: fn(),
    pin: fn(),
    clearPin: fn(),
    toggleLibrary: fn(),
    toggleMetrics: fn(),
    toggleSnap: fn(),
    setTheme: fn(),
    togglePresenting: fn(),
    toggleFullscreen: fn(),
    fit: fn(),
    share: fn(),
    breakIt: fn(),
    glossary: fn(),
    examples: fn(),
    challenges: fn(),
    path: fn(),
    designs: fn(),
    shortcuts: fn(),
    settings: fn(),
  };
};

const labels = (f: CommandFacts) =>
  buildCommands(f, actions(), '5x').map((c) => c.label);
const byId = (f: CommandFacts, a = actions()) =>
  new Map(buildCommands(f, a, '5x').map((c) => [c.id, c] as const));

describe('buildCommands', () => {
  it('names the run action by what it will do', () => {
    expect(labels(facts())).toContain('Pause');
    expect(labels(facts({ running: false }))).toContain('Play');
  });

  it('offers only the faults that apply to each part', () => {
    const l = labels(facts());
    expect(l).toContain('Crash API Server');
    expect(l).toContain('Slow down API Server 5x');
    expect(l).not.toContain('Fix API Server');
    expect(l).not.toContain('Crash Database');
    expect(l).toContain('Fix Database');
    expect(l).not.toContain('Slow down Client 5x');
  });

  it("shows the selected part's faults before anything is typed, and finds the rest", () => {
    const list = buildCommands(facts(), actions(), '5x');
    const bare = rankCommands(list, '').map((c) => c.label);
    expect(bare).toContain('Crash API Server');
    expect(bare).not.toContain('Fix Database');
    expect(rankCommands(list, 'fix data')[0]?.label).toBe('Fix Database');
  });

  it('runs the handler with the right id', () => {
    const a = actions();
    byId(facts(), a).get('fault.crash.api')?.run();
    expect(a.crash).toHaveBeenCalledWith('api');
    byId(facts(), a).get('example.netflix')?.run();
    expect(a.openExample).toHaveBeenCalledWith('netflix');
    byId(facts(), a).get('run.speed.2')?.run();
    expect(a.setSpeed).toHaveBeenCalledWith(2);
  });

  it('says why a row cannot run', () => {
    const m = byId(facts({ inChallenge: true, canPin: false, empty: true }));
    expect(m.get('share.break')?.disabled).toBe('Off during a challenge.');
    expect(m.get('incident.s3')?.disabled).toBe('Leave the challenge first.');
    expect(m.get('run.pin')?.disabled).toMatch(/^Nothing measured yet/);
    expect(m.get('view.fit')?.disabled).toBe('The diagram is empty.');
    const blocked = byId(facts({ breakBlocked: 'Add a client first.' }));
    expect(blocked.get('share.break')?.disabled).toBe('Add a client first.');
  });

  it('prints keys in the reader’s own form, and none on touch', () => {
    expect(byId(facts({ mac: true })).get('help.shortcuts')?.hint).toBe('⌘/');
    expect(byId(facts()).get('help.shortcuts')?.hint).toBe('Ctrl+/');
    const touch = byId(facts({ coarse: true }));
    expect(touch.get('run.toggle')?.hint).toBeUndefined();
    expect(touch.has('help.shortcuts')).toBe(false);
  });

  it('follows presenting and full screen', () => {
    const on = byId(facts({ presenting: true, fullscreen: true }));
    expect(on.get('view.present')?.label).toBe('Stop presenting');
    expect(on.get('view.fullscreen')?.label).toBe('Leave full screen');
    expect(on.get('view.library')?.disabled).toBe('Hidden while presenting.');
    expect(byId(facts({ canFullscreen: false })).has('view.fullscreen')).toBe(false);
  });

  it('keeps glossary terms out of the bare list', () => {
    const list = buildCommands(facts(), actions(), '5x');
    expect(rankCommands(list, '').some((c) => c.group === 'Glossary')).toBe(false);
    expect(rankCommands(list, 'p99')[0]?.label).toBe('p99');
  });

  it('keeps the capitals a name has inside a sentence', () => {
    expect(inSentence('Load balancer')).toBe('load balancer');
    expect(inSentence('CDN')).toBe('CDN');
    expect(inSentence('API gateway')).toBe('API gateway');
    expect(inSentence('WebSocket gateway')).toBe('WebSocket gateway');
  });

  it('has no dashes in its copy', () => {
    for (const l of labels(facts())) expect(l).not.toMatch(/[—–]/);
  });
});
