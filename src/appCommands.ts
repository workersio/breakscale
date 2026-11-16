import type { Command } from './commands';
import type { FailureKind, NodeKind } from './sim/types';
import type { ThemeChoice } from './content/preferences';
import { SPEEDS, formatSpeed, type Speed } from './speed';
import { shortcutLabel } from './modKey';

/* ------------------------------------------------------------------ *
 * Everything the command palette can do, built from what the shell knows.
 *
 * Pure: the shell passes the facts and the handlers it already uses for the
 * bar, the menu, the rail and the inspector, and gets the rows back. Every
 * row runs one of those handlers, so the palette has no undo story or
 * validation of its own to drift from the real one.
 * ------------------------------------------------------------------ */

export interface CommandPart {
  id: string;
  label: string;
  /** The fault in force on it now, or null. */
  fault: FailureKind | null;
  /** False for a kind with no service time, where Slow changes nothing. */
  canSlow: boolean;
}

export interface CommandFacts {
  running: boolean;
  speed: Speed;
  canUndo: boolean;
  canRedo: boolean;
  /** The design has no parts at all. */
  empty: boolean;
  /** Inside a challenge brief. */
  inChallenge: boolean;
  /** Why Can you break it? cannot run, or null. */
  breakBlocked: string | null;
  /** Something has been measured, so a pin would hold real samples. */
  canPin: boolean;
  pinned: boolean;
  libraryOpen: boolean;
  metricsOpen: boolean;
  snapToGrid: boolean;
  theme: ThemeChoice;
  presenting: boolean;
  /** The Fullscreen API exists here. iPhone Safari has none. */
  canFullscreen: boolean;
  fullscreen: boolean;
  /** The selected part first, then the rest in diagram order. */
  parts: readonly CommandPart[];
  /** The one selected part, whose faults show before anything is typed. */
  selectedId: string | null;
  kinds: readonly { kind: NodeKind; name: string; group: string }[];
  examples: readonly { id: string; name: string; tagline: string }[];
  challenges: readonly { id: string; name: string }[];
  incidents: readonly { id: string; name: string }[];
  glossary: readonly { id: string; term: string; aliases?: readonly string[] }[];
  mac: boolean;
  /** No keys to print on a touch screen. */
  coarse: boolean;
}

export interface CommandActions {
  toggleRun: () => void;
  step: () => void;
  reset: () => void;
  setSpeed: (s: Speed) => void;
  undo: () => void;
  redo: () => void;
  add: (kind: NodeKind) => void;
  openExample: (id: string) => void;
  startChallenge: (id: string) => void;
  openIncident: (id: string) => void;
  crash: (id: string) => void;
  slow: (id: string) => void;
  fix: (id: string) => void;
  pin: () => void;
  clearPin: () => void;
  toggleLibrary: () => void;
  toggleMetrics: () => void;
  toggleSnap: () => void;
  setTheme: (t: ThemeChoice) => void;
  togglePresenting: () => void;
  toggleFullscreen: () => void;
  fit: () => void;
  share: () => void;
  breakIt: () => void;
  glossary: (id?: string) => void;
  examples: () => void;
  challenges: () => void;
  path: () => void;
  designs: () => void;
  shortcuts: () => void;
  settings: () => void;
}

/** Slowing a part in the palette uses the same factor as the menu and the
    inspector's first press. */
export const PALETTE_SLOW_LABEL = 'Slow down';

const FAULT_WORD: Record<FailureKind, string> = {
  crash: 'crashed',
  'crash-instance': 'one instance down',
  slow: 'slowed',
  errors: 'glitching',
  partition: 'cut off',
};

export function buildCommands(
  f: CommandFacts,
  a: CommandActions,
  slowFactor: string,
): Command[] {
  const key = (k: string): string | undefined =>
    f.coarse ? undefined : shortcutLabel(k, f.mac);
  const out: Command[] = [];
  const push = (c: Command) => out.push(c);

  /* ---- run ---- */
  push({
    id: 'run.toggle',
    label: f.running ? 'Pause' : 'Play',
    group: 'Run',
    keywords: ['play', 'pause', 'start', 'stop', 'resume'],
    hint: key('Space'),
    run: a.toggleRun,
  });
  push({
    id: 'run.step',
    label: 'Step one tick',
    group: 'Run',
    keywords: ['advance'],
    hint: key('S'),
    run: a.step,
  });
  push({
    id: 'run.reset',
    label: 'Reset the run',
    group: 'Run',
    keywords: ['restart', 'clock', 'zero'],
    run: a.reset,
  });
  for (const s of SPEEDS) {
    push({
      id: `run.speed.${s}`,
      label: `Play at ${formatSpeed(s)}`,
      group: 'Run',
      keywords: ['speed', 'faster', 'slower', 'fast', 'slow motion'],
      hint: s === f.speed ? 'Now' : undefined,
      run: () => a.setSpeed(s),
    });
  }
  push({
    id: 'run.pin',
    label: f.pinned ? 'Pin this run again' : 'Pin this run',
    group: 'Run',
    keywords: ['compare', 'before', 'after', 'baseline', 'snapshot'],
    ...(f.canPin ? {} : { disabled: 'Nothing measured yet. Let some traffic run.' }),
    run: a.pin,
  });
  if (f.pinned) {
    push({
      id: 'run.unpin',
      label: 'Clear the pinned run',
      group: 'Run',
      keywords: ['unpin', 'remove'],
      run: a.clearPin,
    });
  }

  /* ---- faults, the selected part first ---- */
  for (const p of f.parts) {
    // Every other part's faults wait for a search: a forty-part design
    // would otherwise fill the list with them.
    const searchOnly = p.id !== f.selectedId;
    if (p.fault !== 'crash') {
      push({
        id: `fault.crash.${p.id}`,
        label: `Crash ${p.label}`,
        group: 'Faults',
        keywords: ['break', 'kill', 'fail', 'down'],
        searchOnly,
        run: () => a.crash(p.id),
      });
    }
    if (p.fault === null && p.canSlow) {
      push({
        id: `fault.slow.${p.id}`,
        label: `${PALETTE_SLOW_LABEL} ${p.label} ${slowFactor}`,
        group: 'Faults',
        keywords: ['slow', 'latency', 'lag', 'degrade'],
        searchOnly,
        run: () => a.slow(p.id),
      });
    }
    if (p.fault !== null) {
      push({
        id: `fault.fix.${p.id}`,
        label: `Fix ${p.label}`,
        group: 'Faults',
        keywords: ['repair', 'heal', 'recover', 'restore', FAULT_WORD[p.fault]],
        searchOnly,
        run: () => a.fix(p.id),
      });
    }
  }

  /* ---- view ---- */
  if (f.canUndo) {
    push({
      id: 'edit.undo',
      label: 'Undo',
      group: 'View',
      hint: key('Ctrl+Z'),
      run: a.undo,
    });
  }
  if (f.canRedo) {
    push({
      id: 'edit.redo',
      label: 'Redo',
      group: 'View',
      hint: key('Ctrl+Shift+Z'),
      run: a.redo,
    });
  }
  push({
    id: 'view.present',
    label: f.presenting ? 'Stop presenting' : 'Start presenting',
    group: 'View',
    keywords: ['present', 'teach', 'projector', 'class', 'big', 'lecture'],
    hint: key('P'),
    run: a.togglePresenting,
  });
  if (f.canFullscreen) {
    push({
      id: 'view.fullscreen',
      label: f.fullscreen ? 'Leave full screen' : 'Full screen',
      group: 'View',
      keywords: ['fullscreen', 'projector', 'present'],
      run: a.toggleFullscreen,
    });
  }
  push({
    id: 'view.fit',
    label: 'Fit the diagram',
    group: 'View',
    keywords: ['zoom', 'whole', 'everything', 'center'],
    hint: key('Shift+1'),
    ...(f.empty ? { disabled: 'The diagram is empty.' } : {}),
    run: a.fit,
  });
  push({
    id: 'view.library',
    label: f.libraryOpen ? 'Hide components' : 'Show components',
    group: 'View',
    keywords: ['rail', 'palette', 'panel', 'library'],
    hint: key('C'),
    ...(f.presenting ? { disabled: 'Hidden while presenting.' } : {}),
    run: a.toggleLibrary,
  });
  push({
    id: 'view.metrics',
    label: f.metricsOpen ? 'Hide charts' : 'Show charts',
    group: 'View',
    keywords: ['metrics', 'graphs', 'strip', 'panel'],
    hint: key('M'),
    run: a.toggleMetrics,
  });
  push({
    id: 'view.snap',
    label: f.snapToGrid ? 'Turn grid snap off' : 'Turn grid snap on',
    group: 'View',
    keywords: ['grid', 'align', 'snap'],
    hint: key('G'),
    run: a.toggleSnap,
  });
  const themes: [ThemeChoice, string][] = [
    ['light', 'Use the light theme'],
    ['dark', 'Use the dark theme'],
    ['system', 'Match the system theme'],
  ];
  for (const [t, label] of themes) {
    push({
      id: `view.theme.${t}`,
      label,
      group: 'View',
      keywords: ['theme', 'colour', 'color', 'mode', 'appearance'],
      hint: f.theme === t ? 'Now' : undefined,
      run: () => a.setTheme(t),
    });
  }

  /* ---- share and test ---- */
  push({
    id: 'share.link',
    label: 'Share a link to this design',
    group: 'Share',
    keywords: ['share', 'url', 'copy', 'send'],
    run: a.share,
  });
  push({
    id: 'share.break',
    label: 'Can you break it?',
    group: 'Share',
    keywords: ['break', 'fault', 'test', 'attack', 'chaos'],
    hint: key('F'),
    ...(f.inChallenge
      ? { disabled: 'Off during a challenge.' }
      : f.breakBlocked
        ? { disabled: f.breakBlocked }
        : {}),
    run: a.breakIt,
  });

  /* ---- help ---- */
  push({
    id: 'help.examples',
    label: 'Browse examples',
    group: 'Help',
    run: a.examples,
  });
  push({
    id: 'help.challenges',
    label: 'Browse challenges',
    group: 'Help',
    run: a.challenges,
  });
  push({ id: 'help.path', label: 'Learning path', group: 'Help', run: a.path });
  push({
    id: 'help.designs',
    label: 'Your designs',
    group: 'Help',
    keywords: ['saved', 'open', 'files'],
    run: a.designs,
  });
  push({
    id: 'help.glossary',
    label: 'Open the glossary',
    group: 'Help',
    keywords: ['terms', 'definitions', 'words'],
    hint: key('?'),
    run: () => a.glossary(),
  });
  if (!f.coarse) {
    push({
      id: 'help.shortcuts',
      label: 'Keyboard shortcuts',
      group: 'Help',
      keywords: ['keys', 'bindings'],
      hint: key('Ctrl+/'),
      run: a.shortcuts,
    });
  }
  push({
    id: 'help.settings',
    label: 'Settings',
    group: 'Help',
    keywords: ['preferences', 'options', 'tooltips', 'vendor', 'minimap'],
    run: a.settings,
  });
  /* ---- build and open ---- */
  for (const k of f.kinds) {
    push({
      id: `add.${k.kind}`,
      label: `Add ${inSentence(k.name)}`,
      group: 'Add',
      keywords: [k.kind, k.group, 'component', 'new'],
      run: () => a.add(k.kind),
    });
  }

  /* ---- open something ---- */
  for (const e of f.examples) {
    push({
      id: `example.${e.id}`,
      label: e.name,
      group: 'Example',
      keywords: ['example', 'open', e.tagline],
      run: () => a.openExample(e.id),
    });
  }
  for (const c of f.challenges) {
    push({
      id: `challenge.${c.id}`,
      label: c.name,
      group: 'Challenge',
      keywords: ['challenge', 'start', 'brief'],
      run: () => a.startChallenge(c.id),
    });
  }
  for (const i of f.incidents) {
    push({
      id: `incident.${i.id}`,
      label: i.name,
      group: 'Incident',
      keywords: ['incident', 'outage', 'postmortem', 'real'],
      ...(f.inChallenge ? { disabled: 'Leave the challenge first.' } : {}),
      run: () => a.openIncident(i.id),
    });
  }

  for (const g of f.glossary) {
    push({
      id: `glossary.${g.id}`,
      // The term alone: many are not nouns ("Crashed", "Waiting on its
      // calls"), so "What is" around them reads wrong. The group says what
      // the row is.
      label: g.term,
      group: 'Glossary',
      keywords: [...(g.aliases ?? []), 'what is', 'meaning', 'define'],
      searchOnly: true,
      run: () => a.glossary(g.id),
    });
  }
  return out;
}

/**
 * A component name inside a sentence: "Load balancer" becomes "load
 * balancer", while a first word with capitals of its own ("CDN", "API",
 * "WebSocket") keeps them.
 */
export function inSentence(name: string): string {
  const first = name.split(' ', 1)[0] ?? '';
  if (/[A-Z]/.test(first.slice(1))) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
