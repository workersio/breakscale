import type { ActiveFailure, NodeConfig, SimSnapshot, Topology } from '../sim/types';
import {
  formatCount,
  formatElapsed,
  formatMs,
  formatPct,
  formatRateBare,
} from '../components/format';
import { formatFactor } from '../components/faultWiring';
import {
  FULL,
  MIN_RATE,
  mostlyWaiting,
  readParts,
  slotsOf,
  stateClause,
} from './bottleneck';

/**
 * "What just happened": the run so far as a few dated lines a student can
 * read after the fact, built only from the snapshots the app already takes.
 *
 * Every line is a transition the snapshots showed, stamped with the simulated
 * time it was seen at and carrying the numbers of that snapshot. Nothing is
 * predicted or smoothed, so each line can be checked against the canvas at
 * the moment it names. Conditions on a part or on the whole system must hold
 * for HOLD_MS before they count, and must be gone for CLEAR_MS before they
 * are called over, so a reading that flickers across a line is one event and
 * not ten.
 *
 * The tracker is plain mutable state fed one snapshot at a time. It copies
 * the scalars it needs out of each snapshot at once: the engine reuses its
 * per-node objects between snapshots.
 */

/** What a line is, which decides whether it opens the panel. */
export type Tone =
  /** Something was done to the system: a fault or a cut. */
  | 'cause'
  /** The system got worse. */
  | 'trouble'
  /** The system got better. */
  | 'better'
  /** A change the student made: load or a setting. */
  | 'change';

export interface TimelineEvent {
  readonly id: number;
  /** Simulated time, ms. */
  readonly atMs: number;
  readonly text: string;
  readonly tone: Tone;
  /**
   * Trouble users feel straight away: requests failing, slow, refused or
   * given up on. A part merely running full is not loud on its own; some
   * examples run one part hot at their starting load by design.
   */
  readonly loud: boolean;
}

/** A condition must hold this long, in simulated time, before it is a line. */
export const HOLD_MS = 1000;
/** And be gone this long before it is called over. */
export const CLEAR_MS = 2000;
/** Edits closer together than this are one change: a slider drag is one line. */
const MERGE_MS = 2000;
/** A part that recovers and slips back within this long was never really over. */
const RELAPSE_MS = 5000;
/**
 * System error rate that counts as users failing, and the rate it must fall
 * back under. Some examples run at 1 to 2 percent by design (a payment
 * decline is an error), so the line is the red one, not the first percent.
 */
const ERRORS = 0.05;
const ERRORS_CLEAR = 0.02;
/** p99 at which the headline turns red (healthOfLatency's danger line). */
const SLOW_P99_MS = 1000;
/**
 * A worst point gets its own line once it is this far past the first one,
 * and that line is rewritten each time it moves on by WORSE_BY again.
 */
const WORST_LINE = 0.05;
const WORSE_BY = 0.01;
/** Lines kept in memory; the panel shows fewer. */
const KEEP = 40;

type Cond = 'full' | 'waiting' | 'refusing' | 'givingUp';
const CONDS: readonly Cond[] = ['full', 'waiting', 'refusing', 'givingUp'];

interface Hold {
  since: number | null;
  fired: boolean;
}

interface PartTrack {
  holds: Record<Cond, Hold>;
  troubled: boolean;
  clearSince: number | null;
  /** The "keeping up again" line, while a relapse could still take it back. */
  recovered: TimelineEvent | null;
}

/** An edit still open to merging with the next one. */
interface OpenEdit {
  event: TimelineEvent;
  from: number;
  lastAt: number;
}

/** Config fields a student sets often enough to name, with how to say them. */
const NAMED_FIELDS: readonly {
  key: keyof NodeConfig;
  words: string;
  show: (v: number) => string;
}[] = [
  { key: 'instances', words: 'instances', show: formatCount },
  { key: 'capacity', words: 'slots per instance', show: formatCount },
  { key: 'serviceMs', words: 'service time', show: formatMs },
  { key: 'queueLimit', words: 'room in its line', show: formatCount },
  { key: 'timeoutMs', words: 'timeout', show: formatMs },
  { key: 'retries', words: 'retries', show: formatCount },
];

export class Timeline {
  private list: TimelineEvent[] = [];
  private seq = 0;
  private lastMs = -1;
  private nodeIds = new Set<string>();
  private labels = new Map<string, string>();
  private configs = new Map<string, NodeConfig>();
  private faults = new Map<string, string>();
  private cuts = new Set<string>();
  private load = 0;
  private loadEdit: OpenEdit | null = null;
  private fieldEdits = new Map<string, OpenEdit>();
  private parts = new Map<string, PartTrack>();
  private errors: Hold = { since: null, fired: false };
  private errorsClearSince: number | null = null;
  private worst: { event: TimelineEvent | null; rate: number } | null = null;
  private slow: Hold = { since: null, fired: false };
  private slowClearSince: number | null = null;
  private dropped = 0;

  /** Lines in time order, oldest first. */
  events(): readonly TimelineEvent[] {
    return this.list;
  }

  /** How many older lines were let go to keep memory bounded. */
  droppedCount(): number {
    return this.dropped;
  }

  /**
   * Take one snapshot. Returns true when the lines changed.
   *
   * A clock that went backwards is a Reset or a newly loaded design, and so
   * is a design that shares no part with the one before: the old run's lines
   * are dropped and the new run starts silent.
   */
  observe(topology: Topology, snapshot: SimSnapshot): boolean {
    const t = snapshot.system.timeMs;
    const before = this.seq;
    const hadLines = this.list.length > 0;
    const replaced =
      this.nodeIds.size > 0 &&
      topology.nodes.length > 0 &&
      !topology.nodes.some((n) => this.nodeIds.has(n.id));
    if (this.lastMs < 0 || t < this.lastMs || replaced) {
      this.restart(topology);
      this.lastMs = t;
      this.watchFaults(snapshot, t);
      return hadLines || this.seq !== before;
    }

    this.watchDesign(topology, t);
    this.watchFaults(snapshot, t);
    // A paused edit arrives with the clock unchanged; conditions only move
    // when time does.
    if (t > this.lastMs) {
      this.watchParts(topology, snapshot, t);
      this.watchSystem(snapshot, t);
      this.lastMs = t;
    }
    return this.seq !== before;
  }

  /* ---------------- bookkeeping ---------------- */

  private restart(topology: Topology): void {
    this.list = [];
    this.dropped = 0;
    this.faults.clear();
    this.cuts.clear();
    this.parts.clear();
    this.fieldEdits.clear();
    this.loadEdit = null;
    this.errors = { since: null, fired: false };
    this.errorsClearSince = null;
    this.worst = null;
    this.slow = { since: null, fired: false };
    this.slowClearSince = null;
    this.seq += 1;
    this.remember(topology);
  }

  private remember(topology: Topology): void {
    this.nodeIds = new Set(topology.nodes.map((n) => n.id));
    this.labels = new Map(topology.nodes.map((n) => [n.id, n.label]));
    this.configs = new Map(topology.nodes.map((n) => [n.id, n.config]));
    this.load = clientLoad(topology);
    this.edgeEnds = new Map(topology.edges.map((e) => [e.id, [e.from, e.to]]));
  }

  private push(
    atMs: number,
    text: string,
    tone: Tone,
    loud = false,
    id?: number,
  ): TimelineEvent {
    this.seq += 1;
    const event: TimelineEvent = { id: id ?? this.seq, atMs, text, tone, loud };
    // Fault lines carry the engine's own injection time, which can sit a
    // fraction before the snapshot that revealed them; keep time order.
    let i = this.list.length;
    while (i > 0 && (this.list[i - 1]?.atMs ?? 0) > atMs) i -= 1;
    this.list.splice(i, 0, event);
    if (this.list.length > KEEP) {
      this.list.shift();
      this.dropped += 1;
    }
    return event;
  }

  /** A rewrite keeps its id: it is the same line, so it must not count as news. */
  private replace(old: TimelineEvent, atMs: number, text: string): TimelineEvent {
    this.remove(old);
    return this.push(atMs, text, old.tone, old.loud, old.id);
  }

  private remove(event: TimelineEvent): void {
    const i = this.list.indexOf(event);
    if (i >= 0) this.list.splice(i, 1);
    this.seq += 1;
  }

  private name(id: string): string {
    return this.labels.get(id) ?? 'A removed part';
  }

  /* ---------------- what the student did ---------------- */

  private watchDesign(topology: Topology, t: number): void {
    const oldIds = this.nodeIds;
    const oldLabels = this.labels;
    const oldConfigs = this.configs;
    const oldLoad = this.load;
    this.remember(topology);

    for (const n of topology.nodes) {
      if (!oldIds.has(n.id)) {
        this.push(t, `You added ${n.label}.`, 'change');
        continue;
      }
      const was = oldConfigs.get(n.id);
      if (!was || was === n.config || n.kind === 'client') continue;
      let changed = false;
      for (const f of NAMED_FIELDS) {
        const a = was[f.key];
        const b = n.config[f.key];
        if (a === b) continue;
        changed = true;
        if (typeof a !== 'number' || typeof b !== 'number') continue;
        this.edit(
          `${n.id}:${f.key}`,
          a,
          b,
          t,
          (from, to) =>
            `You changed ${n.label}'s ${f.words} from ${f.show(from)} to ${f.show(to)}.`,
        );
      }
      if (!changed && !sameConfig(was, n.config)) {
        this.edit(`${n.id}:other`, 0, 1, t, () => `You changed ${n.label}'s settings.`);
      }
    }
    for (const id of oldIds) {
      if (!this.nodeIds.has(id)) {
        this.push(t, `You removed ${oldLabels.get(id) ?? 'a part'}.`, 'change');
        this.parts.delete(id);
        this.faults.delete(id);
      }
    }

    if (this.load !== oldLoad) {
      const open = this.loadEdit;
      const latest = this.list[this.list.length - 1];
      if (open && open.event === latest && t - open.lastAt <= MERGE_MS) {
        this.loadEdit = this.rewriteEdit(open, this.load, t, loadText);
      } else {
        const event = this.push(t, loadText(oldLoad, this.load), 'change');
        this.loadEdit = { event, from: oldLoad, lastAt: t };
      }
    }
  }

  /**
   * One line per setting per burst of edits: a second change to the same
   * field soon after the first rewrites the first line, keeping where it
   * started, and an edit back to where it started removes the line.
   */
  private edit(
    key: string,
    from: number,
    to: number,
    t: number,
    say: (from: number, to: number) => string,
  ): void {
    const open = this.fieldEdits.get(key);
    if (open && this.list.includes(open.event) && t - open.lastAt <= MERGE_MS) {
      const next = this.rewriteEdit(open, to, t, say);
      if (next) this.fieldEdits.set(key, next);
      else this.fieldEdits.delete(key);
      return;
    }
    const event = this.push(t, say(from, to), 'change');
    this.fieldEdits.set(key, { event, from, lastAt: t });
  }

  private rewriteEdit(
    open: OpenEdit,
    to: number,
    t: number,
    say: (from: number, to: number) => string,
  ): OpenEdit | null {
    if (to === open.from) {
      this.remove(open.event);
      return null;
    }
    const event = this.replace(open.event, open.event.atMs, say(open.from, to));
    return { event, from: open.from, lastAt: t };
  }

  /* ---------------- faults and cut links ---------------- */

  private watchFaults(snapshot: SimSnapshot, t: number): void {
    const now = new Map<string, string>();
    const byNode = new Map<string, ActiveFailure>();
    const partitioned = new Set<string>();
    for (const f of snapshot.activeFailures) {
      now.set(f.nodeId, faultKey(f));
      byNode.set(f.nodeId, f);
      for (const e of f.edgeIds ?? []) partitioned.add(e);
    }
    for (const [id, key] of now) {
      if (this.faults.get(id) === key) continue;
      const f = byNode.get(id);
      if (f) this.push(f.sinceMs, faultText(f, this.name(id)), 'cause');
    }
    for (const id of this.faults.keys()) {
      if (!now.has(id) && this.nodeIds.has(id)) {
        this.push(t, `The fault on ${this.name(id)} was cleared.`, 'better');
      }
    }
    this.faults = now;

    // Links cut on their own. A partition's links are its fault's line.
    const cuts = new Set<string>();
    for (const [id, state] of Object.entries(snapshot.edgeState)) {
      if (state === 'cut' && !partitioned.has(id)) cuts.add(id);
    }
    for (const id of cuts) {
      if (!this.cuts.has(id))
        this.push(t, `The link ${this.link(id)} was cut.`, 'cause');
    }
    for (const id of this.cuts) {
      if (!cuts.has(id) && id in snapshot.edgeState) {
        this.push(t, `The link ${this.link(id)} was restored.`, 'better');
      }
    }
    this.cuts = cuts;
  }

  private edgeEnds = new Map<string, [string, string]>();

  private link(edgeId: string): string {
    const ends = this.edgeEnds.get(edgeId);
    return ends
      ? `from ${this.name(ends[0])} to ${this.name(ends[1])}`
      : 'between two parts';
  }

  /* ---------------- each part ---------------- */

  private watchParts(topology: Topology, snapshot: SimSnapshot, t: number): void {
    const readings = readParts(topology, snapshot);
    const byId = new Map(readings.map((r) => [r.node.id, r]));
    for (const r of readings) {
      const waiting = r.s.waitingOnDownstream ?? 0;
      const on: Record<Cond, boolean> = {
        full: r.struggling && r.fill >= FULL && !mostlyWaiting(r),
        waiting: r.fill >= FULL && mostlyWaiting(r) && waiting >= 1,
        refusing: r.refused >= MIN_RATE,
        givingUp: r.gaveUp >= MIN_RATE,
      };
      const track = this.track(r.node.id);
      let any = false;
      for (const c of CONDS) {
        const h = track.holds[c];
        if (!on[c]) {
          h.since = null;
          continue;
        }
        any = true;
        h.since ??= t;
        if (h.fired || t - h.since < HOLD_MS) continue;
        h.fired = true;
        // A relapse soon after "keeping up again" takes that line back
        // rather than adding a second round of the same story.
        const back = track.recovered;
        if (back && t - back.atMs <= RELAPSE_MS && this.list.includes(back)) {
          this.remove(back);
          track.recovered = null;
          track.troubled = true;
          continue;
        }
        track.troubled = true;
        track.recovered = null;
        // One line per fact: a full line names refusals unless a line
        // already did, and then the refusals need no line of their own.
        const said = track.holds.refusing.fired;
        if (c === 'full' && on.refusing) track.holds.refusing.fired = true;
        const label = r.node.label;
        const text =
          c === 'full'
            ? `${label}: ${stateClause(said ? { ...r, refused: 0 } : r, byId, topology)}.`
            : c === 'waiting'
              ? `${label}: ${waitingClause(waiting, slotsOf(r.node, r.s))} waiting on its calls.`
              : c === 'refusing'
                ? `${label} started turning away ${formatRateBare(r.refused)} a second.`
                : `${label} started giving up on slow calls, ${formatRateBare(r.gaveUp)} a second.`;
        this.push(t, text, 'trouble', c === 'refusing' || c === 'givingUp');
      }
      if (any) {
        track.clearSince = null;
      } else if (track.troubled) {
        track.clearSince ??= t;
        if (t - track.clearSince >= CLEAR_MS) {
          track.troubled = false;
          track.clearSince = null;
          for (const c of CONDS) track.holds[c].fired = false;
          track.recovered = this.push(
            t,
            `${r.node.label} is keeping up again.`,
            'better',
          );
        }
      }
    }
  }

  private track(id: string): PartTrack {
    let p = this.parts.get(id);
    if (!p) {
      p = {
        holds: {
          full: { since: null, fired: false },
          waiting: { since: null, fired: false },
          refusing: { since: null, fired: false },
          givingUp: { since: null, fired: false },
        },
        troubled: false,
        clearSince: null,
        recovered: null,
      };
      this.parts.set(id, p);
    }
    return p;
  }

  /* ---------------- the whole system ---------------- */

  private watchSystem(snapshot: SimSnapshot, t: number): void {
    const err = snapshot.system.errorRate;
    if (err >= ERRORS || (this.errors.fired && err >= ERRORS_CLEAR)) {
      this.errorsClearSince = null;
      this.errors.since ??= t;
      if (!this.errors.fired && t - this.errors.since >= HOLD_MS) {
        this.errors.fired = true;
        this.push(t, `${formatPct(err)} of requests started failing.`, 'trouble', true);
        this.worst = { event: null, rate: err };
      } else if (
        this.worst &&
        err >= this.worst.rate + (this.worst.event ? WORSE_BY : WORST_LINE)
      ) {
        const text = `Worst so far: ${formatPct(err)} of requests failing.`;
        this.worst = {
          event: this.worst.event
            ? this.replace(this.worst.event, t, text)
            : this.push(t, text, 'trouble', true),
          rate: err,
        };
      }
    } else {
      this.errors.since = null;
      if (this.errors.fired) {
        this.errorsClearSince ??= t;
        if (t - this.errorsClearSince >= CLEAR_MS) {
          this.errors.fired = false;
          this.errorsClearSince = null;
          this.worst = null;
          this.push(
            t,
            err > 0
              ? `Requests are getting through again, only ${formatPct(err)} failing.`
              : `Requests are getting through again, none failing.`,
            'better',
          );
        }
      }
    }

    const p99 = snapshot.system.p99;
    if (p99 >= SLOW_P99_MS) {
      this.slowClearSince = null;
      this.slow.since ??= t;
      if (!this.slow.fired && t - this.slow.since >= HOLD_MS) {
        this.slow.fired = true;
        this.push(
          t,
          `p99 passed 1s: the slowest 1 in 100 requests took ${formatMs(p99)}.`,
          'trouble',
          true,
        );
      }
    } else {
      this.slow.since = null;
      if (this.slow.fired) {
        this.slowClearSince ??= t;
        if (t - this.slowClearSince >= CLEAR_MS) {
          this.slow.fired = false;
          this.slowClearSince = null;
          this.push(t, `p99 is back under 1s, at ${formatMs(p99)}.`, 'better');
        }
      }
    }
  }
}

/* ---------------- sentences and small helpers ---------------- */

/** "3.0s", the ledger's own clock format. */
export function formatAt(ms: number): string {
  return formatElapsed(ms / 1000);
}

function clientLoad(topology: Topology): number {
  let sum = 0;
  for (const n of topology.nodes) if (n.kind === 'client') sum += n.config.rps ?? 0;
  return sum;
}

function loadText(from: number, to: number): string {
  const dir = to > from ? 'raised' : 'lowered';
  return `You ${dir} the load from ${formatRateBare(from)} to ${formatRateBare(to)} a second.`;
}

function waitingClause(waiting: number, slots: number | null): string {
  return slots === null
    ? `${formatCount(waiting)} slots`
    : `${formatCount(waiting)} of its ${formatCount(slots)} slots`;
}

function faultKey(f: ActiveFailure): string {
  return `${f.kind}|${f.sinceMs}|${f.factor ?? ''}|${f.rate ?? ''}|${f.edgeIds?.length ?? ''}`;
}

function faultText(f: ActiveFailure, name: string): string {
  switch (f.kind) {
    case 'crash':
      return `${name} crashed.`;
    case 'crash-instance':
      return `One of ${name}'s machines crashed.`;
    case 'slow':
      return `${name} slowed down ${formatFactor(f.factor ?? 1)}.`;
    case 'errors':
      return `${name} started failing ${formatPct(f.rate ?? 0)} of its requests.`;
    case 'partition': {
      const cut = f.edgeIds?.length ?? 0;
      return `${name} was cut off from ${cut === 1 ? 'one of its links' : `${cut} of its links`}.`;
    }
  }
}

function sameConfig(a: NodeConfig, b: NodeConfig): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = (a as unknown as Record<string, unknown>)[k];
    const y = (b as unknown as Record<string, unknown>)[k];
    if (x !== y && JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

/**
 * Whether a line newer than `afterId` should bring the panel up by itself.
 *
 * A fault, a cut or trouble users feel always does. A part running full only
 * does once the student has changed something in this run: a few examples
 * run one part hot at their starting load, and a panel that opened on its own
 * there would be crying wolf before anyone had touched anything.
 */
export function wantsAttention(
  events: readonly TimelineEvent[],
  afterId: number,
): boolean {
  return firstAttention(events, afterId) !== null;
}

/** The first line after `afterId` that opens the panel, or null. */
export function firstAttention(
  events: readonly TimelineEvent[],
  afterId: number,
): TimelineEvent | null {
  let touched = false;
  for (const e of events) {
    if (e.tone === 'change' || e.tone === 'cause') touched = true;
    if (e.id <= afterId) continue;
    if (e.tone === 'cause' || (e.tone === 'trouble' && (e.loud || touched))) return e;
  }
  return null;
}
