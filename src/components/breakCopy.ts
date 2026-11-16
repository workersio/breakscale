import type {
  Attack,
  Closest,
  SearchPhase,
  SeedRun,
  SinglePoint,
} from '../sim/breakit';
import { BREAK_END_MS, BREAK_WARMUP_MS } from '../sim/breakit';
import type { Goal } from '../sim/challenge';
import type { RequestTimeline, TimelineEvent, Violation } from '../sim/oplog';
import type { FailureReason } from '../sim/types';
import { formatCount, formatGoalMs, formatGoalPct, formatShareDown } from './format';

/* ------------------------------------------------------------------ *
 * The words "Can you break it?" uses: fault phrases, schedules and
 * verdict sentences. Kept apart from the panel so they can be tested
 * without rendering anything.
 * ------------------------------------------------------------------ */

/** Names for the parts of a design, by id. */
export interface Names {
  node: (id: string) => string;
  /** An edge as "the cable from A to B". */
  edge: (id: string) => string;
}

/** Seconds as a reader would say them: "12s", "0.5s". */
export function secs(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** One fault, without its timing: "slow Database 5x". */
export function faultPhrase(a: Attack, names: Names): string {
  switch (a.kind) {
    case 'crash':
      return `crash ${names.node(a.target)}`;
    case 'crash-instance':
      return `take down one machine of ${names.node(a.target)}`;
    case 'slow':
      return `slow ${names.node(a.target)} ${a.factor}x`;
    case 'errors':
      return `make ${names.node(a.target)} fail ${pct(a.rate)} of requests`;
    case 'cut':
      return `cut ${names.edge(a.target)}`;
    case 'duplicate':
      return `make ${names.edge(a.target)} deliver ${pct(a.rate)} of requests twice`;
    case 'pause':
      return `stall ${names.node(a.target)}`;
    case 'cut-replies':
      return `make ${names.edge(a.target)} lose its answers`;
  }
}

/** One fault with its timing: "slow Database 5x at 10s for 5s". */
export function attackPhrase(a: Attack, names: Names): string {
  const length = a.forMs === null ? '' : ` for ${secs(a.forMs)}`;
  return `${faultPhrase(a, names)} at ${secs(a.atMs)}${length}`;
}

/**
 * A whole schedule as one sentence. Faults at the same moment are joined
 * with "and", later ones with "then". Times are on the replay's clock.
 */
export function scheduleSentence(attacks: readonly Attack[], names: Names): string {
  const groups: Attack[][] = [];
  for (const a of attacks) {
    const last = groups[groups.length - 1];
    if (last && last[0].atMs === a.atMs) last.push(a);
    else groups.push([a]);
  }
  const text = groups
    .map((g) => g.map((a) => attackPhrase(a, names)).join(' and '))
    .join(', then ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The counted window, as the verdict names it. */
export const WINDOW_PHRASE = `Between ${secs(BREAK_WARMUP_MS)} and ${secs(BREAK_END_MS)}`;

/** Whose requests a goal is about: "requests" or "requests from Checkout". */
function whose(goal: Goal, names: Names): string {
  return goal.route === undefined
    ? 'requests'
    : `requests from ${names.node(goal.route)}`;
}

/**
 * The line a goal has to stay under, as the verdict quotes it. A run that
 * fell behind broke whatever the goal said, so it gets the reason instead.
 */
export function goalLine(goal: Goal, run?: SeedRun): string {
  if (run?.outcome === 'falling-behind') {
    return 'A backlog that keeps growing fails everything in the end, so this counts as broken whatever the goal.';
  }
  switch (goal.metric) {
    case 'errorRate':
      return `The goal was ${formatGoalPct(goal.max)} or less.`;
    case 'p99':
      return `The goal was ${formatGoalMs(goal.max)} or less.`;
    case 'p95':
      return `The goal was ${formatGoalMs(goal.max)} or less.`;
    default:
      return goal.max === 0
        ? 'The goal was none.'
        : `The goal was ${goal.max} or fewer.`;
  }
}

/** What a run did to the goal, in a sentence, without the goal itself. */
export function effectSentence(run: SeedRun, goal: Goal, names: Names): string {
  const who = whose(goal, names);
  if (run.outcome === 'nothing-completed') {
    return `${WINDOW_PHRASE}, none of the ${who} got through.`;
  }
  if (run.outcome === 'falling-behind') {
    const share = formatShareDown(run.keptUp);
    const answered = (run.keptUp ?? 0) > 0.9 ? share : `only ${share}`;
    return `${WINDOW_PHRASE}, ${who} piled up faster than they finished: ${answered} got an answer and the rest were still waiting.`;
  }
  switch (goal.metric) {
    case 'errorRate':
      return run.actual === null
        ? `${WINDOW_PHRASE}, none of the ${who} got an answer.`
        : `${WINDOW_PHRASE}, ${formatGoalPct(run.actual)} of ${who} failed.`;
    case 'p99':
      return `${WINDOW_PHRASE}, the slowest 1 in 100 ${who} took ${formatGoalMs(run.actual)} or longer.`;
    case 'p95':
      return `${WINDOW_PHRASE}, the slowest 1 in 20 ${who} took ${formatGoalMs(run.actual)} or longer.`;
    case 'lostWrites':
      return `${run.actual ?? 0} saved ${run.actual === 1 ? 'write' : 'writes'} never reached the database.`;
    case 'lostJobs':
      return `${run.actual ?? 0} accepted ${run.actual === 1 ? 'job' : 'jobs'} failed later.`;
    case 'doubleCharges':
      return `${WINDOW_PHRASE}, ${run.actual ?? 0} ${run.actual === 1 ? 'payment was' : 'payments were'} charged more than once.`;
    case 'lostAckedWrites':
      return `${WINDOW_PHRASE}, ${run.actual ?? 0} ${run.actual === 1 ? 'write' : 'writes'} the client was told ${run.actual === 1 ? 'was' : 'were'} saved never reached storage.`;
    case 'staleReads':
      return `${WINDOW_PHRASE}, ${run.actual ?? 0} ${run.actual === 1 ? 'read' : 'reads'} missed a write the same client had been told was saved.`;
    case 'queueDepth':
      return '';
  }
}

/** The fault-free figure under a goal: "With no faults, 0.4% of requests fail." */
export function baselineSentence(run: SeedRun, goal: Goal, names: Names): string {
  const who = whose(goal, names);
  if (run.outcome === 'nothing-completed')
    return `With no faults, none of the ${who} get through.`;
  if (run.outcome === 'falling-behind') {
    return `With no faults, ${who} already pile up faster than they finish.`;
  }
  switch (goal.metric) {
    case 'errorRate':
      return `With no faults, ${formatGoalPct(run.actual)} of ${who} fail.`;
    case 'p99':
      return `With no faults, 99 in 100 ${who} finish within ${formatGoalMs(run.actual)}.`;
    case 'p95':
      return `With no faults, 19 in 20 ${who} finish within ${formatGoalMs(run.actual)}.`;
    case 'lostWrites':
      return `With no faults, ${run.actual ?? 0} saved writes are lost.`;
    case 'lostJobs':
      return `With no faults, ${run.actual ?? 0} accepted jobs fail.`;
    case 'doubleCharges':
      return run.actual === 0
        ? 'With no faults, no payment is charged twice.'
        : `With no faults, ${run.actual ?? 0} ${run.actual === 1 ? 'payment is' : 'payments are'} charged more than once.`;
    case 'lostAckedWrites':
      return run.actual === 0
        ? 'With no faults, every write the client is told was saved reaches storage.'
        : `With no faults, ${run.actual ?? 0} ${run.actual === 1 ? 'write' : 'writes'} the client is told ${run.actual === 1 ? 'was' : 'were'} saved never ${run.actual === 1 ? 'reaches' : 'reach'} storage.`;
    case 'staleReads':
      return run.actual === 0
        ? 'With no faults, every read shows the writes its client was told were saved.'
        : `With no faults, ${run.actual ?? 0} ${run.actual === 1 ? 'read misses' : 'reads miss'} a write the same client was told was saved.`;
    case 'queueDepth':
      return '';
  }
}

/** What the search is doing, announced as it changes. */
export function phaseLine(phase: SearchPhase): string {
  switch (phase) {
    case 'baseline':
      return 'Measuring it with no faults';
    case 'remembered':
      return 'Trying the faults that broke it last time';
    case 'single':
      return 'Trying one fault at a time';
    case 'pair':
      return 'Trying two at once';
    case 'triple':
      return 'Trying three at once';
    case 'shrink':
      return 'Found a way in. Making it smaller';
  }
}

/** The near miss so far, or that there has not been one. */
export function closestLine(closest: Closest | null, goal: Goal, names: Names): string {
  if (closest === null || closest.score < 0.5) return 'Nothing has come close yet.';
  const sentence = scheduleSentence(closest.attacks, names).slice(0, -1);
  const what = `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
  if (closest.outcome === 'falling-behind' || closest.pilingUp) {
    return `Closest call: ${what}. Requests started to pile up.`;
  }
  switch (goal.metric) {
    case 'errorRate':
      return `Closest call: ${what}. ${formatGoalPct(closest.actual)} failed.`;
    case 'p99':
    case 'p95':
      return `Closest call: ${what}. The slowest took ${formatGoalMs(closest.actual)}.`;
    default:
      return `Closest call: ${what}.`;
  }
}

/** How many of each size the search tried. */
export function triedLine(bySize: readonly [number, number, number]): string {
  const parts = [`One fault: ${bySize[0]}.`];
  if (bySize[1] > 0) parts.push(`Two at once: ${bySize[1]}.`);
  if (bySize[2] > 0) parts.push(`Three at once: ${bySize[2]}.`);
  return parts.join(' ');
}

/** A list as a reader would say it: "A, B and C". */
function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The single points of failure as findings, one line per traffic source:
 * "Every request from Client has to pass through API Server and Database."
 */
export function singlePointLines(
  points: readonly SinglePoint[],
  names: Names,
): string[] {
  const byClient = new Map<string, string[]>();
  for (const p of points) {
    const what = p.type === 'node' ? names.node(p.id) : names.edge(p.id);
    for (const c of p.clients) {
      const list = byClient.get(c);
      if (list) list.push(what);
      else byClient.set(c, [what]);
    }
  }
  // Parts first, cables after, so the sentence reads boxes then wires.
  return [...byClient].map(([c, parts]) => {
    const boxes = parts.filter((x) => !x.startsWith('the cable'));
    const cables = parts.filter((x) => x.startsWith('the cable'));
    return `Every request from ${names.node(c)} has to pass through ${listed([...boxes, ...cables])}.`;
  });
}

/* ---------------- correctness evidence ---------------- */

/** A time on the replay's clock to the hundredth of a second: "10.64s". */
export function clock(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** How a write's kept copy was lost, after "lost": "when Database crashed". */
function lostHow(reason: FailureReason, at: string): string {
  switch (reason) {
    case 'crashed':
      return `when ${at} crashed`;
    case 'partitioned':
      return `on a cut cable from ${at}`;
    case 'packet-loss':
      return `on a lossy link from ${at}`;
    case 'timeout':
      return `when ${at} timed out saving it`;
    default:
      return `when ${at} failed to save it`;
  }
}

function times(n: number): string {
  return n === 2 ? 'twice' : `${n} times`;
}

/**
 * The earliest violation as evidence: which request, what happened to it
 * and when, on the replay's clock.
 */
export function evidenceSentence(v: Violation, names: Names): string {
  if (v.check === 'atMostOnce') {
    const at = v.chargedMs.map(clock);
    const told =
      v.outcome === 'ok'
        ? 'The client was told it went through.'
        : v.outcome === 'failed'
          ? 'The client was told it failed.'
          : 'The client never heard back.';
    const where = new Set(v.nodeIds);
    if (where.size > 1) {
      const each = v.nodeIds.map((id, i) => `at ${names.node(id)} at ${at[i]}`);
      return `Request ${v.rid} was charged ${times(v.chargedMs.length)}, ${listed(each)}. ${told}`;
    }
    return `Request ${v.rid} was charged ${times(v.chargedMs.length)} at ${names.node(v.nodeId)}, at ${listed(at)}. ${told}`;
  }
  if (v.check === 'readYourWrites') {
    return `Request ${v.rid} read a record at ${names.node(v.nodeId)} at ${clock(v.readMs)}. The same client had been told at ${clock(v.savedMs)} that request ${v.wroteRid} saved a change to it, but the change only showed up in reads at ${clock(v.visibleMs)}, so the read got the old value.`;
  }
  if (v.copy === 'disk') {
    return `Request ${v.rid} was saved by ${names.node(v.nodeId)} at ${clock(v.bufferedMs)}, and the client was told so, but it was still in memory. It was lost when ${names.node(v.lostAt)} went down at ${clock(v.lostMs)}, before it reached disk.`;
  }
  return `Request ${v.rid} was held in ${names.node(v.nodeId)} at ${clock(v.bufferedMs)}, and the client was told it was saved. It was lost ${lostHow(v.reason, names.node(v.lostAt))} at ${clock(v.lostMs)}, before it reached storage.`;
}

/** The line an event is drawn with: "Charged again" and "Lost" carry the meaning in words. */
export type TimelineTag = 'charged-again' | 'lost' | 'stale' | null;

export interface TimelineLine {
  t: number;
  text: string;
  tag: TimelineTag;
}

/** One line of a request's story. `v` is the violation it is followed for. */
function eventLine(e: TimelineEvent, names: Names, v?: Violation): TimelineLine {
  const n = names.node;
  const line = (text: string, tag: TimelineTag = null): TimelineLine => ({
    t: e.t,
    text,
    tag,
  });
  switch (e.type) {
    case 'invoke':
      return line(`${n(e.node)} sends it.`);
    case 'send':
      // Tries count from 0 in the log: try 0 is the first call.
      return line(
        e.attempt > 0
          ? `${n(e.from)} calls ${n(e.to)} again, try ${e.attempt + 1}.`
          : `${n(e.from)} calls ${n(e.to)}.`,
      );
    case 'lost':
      return line(`${n(e.from)}'s call to ${n(e.to)} never arrives.`, 'lost');
    case 'reply-lost':
      return line(
        e.ok
          ? `${n(e.node)} answers, but the answer is lost on the way back to ${n(e.to)}.`
          : `${n(e.node)} answers that it failed, but the answer is lost on the way back to ${n(e.to)}.`,
        'lost',
      );
    case 'duplicate':
      return line(
        `The cable delivers ${n(e.from)}'s call to ${n(e.to)} a second time.`,
      );
    case 'timeout':
      return line(
        `${n(e.node)} stops waiting for ${n(e.to)}. That try keeps running there.`,
      );
    case 'retry':
      return line(`${n(e.node)} will try ${n(e.to)} again.`);
    case 'apply':
      if (v?.check === 'readYourWrites' && e.node === v.nodeId && e.t >= v.readMs) {
        return line(
          `${n(e.node)} answers the read from before request ${v.wroteRid}'s write showed up.`,
          'stale',
        );
      }
      if (!e.charge) return line(`${n(e.node)} does its part.`);
      return e.repeat
        ? line(`${n(e.node)} charges the card again.`, 'charged-again')
        : line(`${n(e.node)} charges the card.`);
    case 'dedupe':
      return line(
        e.inFlight
          ? `${n(e.node)} refuses it: the same request is still being worked on.`
          : `${n(e.node)} has done this request already, so it answers with the first result.`,
      );
    case 'buffered':
      return line(
        e.disk
          ? `${n(e.node)} saves it and says so, but has not written it to disk yet.`
          : `${n(e.node)} says it is saved, but only holds it in memory.`,
      );
    case 'landed':
      return line(
        e.disk
          ? `${n(e.node)} writes it to disk.`
          : `${n(e.node)}'s copy reaches storage.`,
      );
    case 'dropped':
      return line(
        e.disk
          ? `${n(e.node)} goes down before writing it to disk, so it is lost.`
          : `${n(e.node)}'s copy is lost ${lostHow(e.reason, n(e.at))}.`,
        'lost',
      );
    case 'answer':
      if (e.heard === 'client') {
        return line(
          e.ok ? 'The client hears it worked.' : 'The client hears it failed.',
        );
      }
      if (e.heard === 'nobody') {
        return line(
          e.ok
            ? `${n(e.node)} finishes, but nobody is waiting for the answer.`
            : `${n(e.node)} fails, but nobody is waiting for the answer.`,
        );
      }
      return line(
        e.ok ? `${n(e.node)} answers.` : `${n(e.node)} answers that it failed.`,
      );
  }
}

/** A request's story in lines, in the order it happened. */
export function timelineWords(
  tl: RequestTimeline,
  names: Names,
  v?: Violation,
): TimelineLine[] {
  // A try whose answer was lost has already finished, so when its caller
  // gives up on it, it is not still running anywhere.
  const answered = new Set<string>();
  return tl.events.map((e) => {
    if (e.type === 'reply-lost') answered.add(`${e.to}|${e.node}|${e.attempt}`);
    if (e.type === 'timeout' && answered.has(`${e.node}|${e.to}|${e.attempt}`)) {
      return {
        t: e.t,
        text: `${names.node(e.node)} stops waiting for ${names.node(e.to)}, never having heard back.`,
        tag: null,
      };
    }
    return eventLine(e, names, v);
  });
}

/**
 * For a correctness goal that held: that every schedule was checked, how
 * many things that is on the run with no faults, and what was not checked.
 */
export function checkedLine(goal: Goal, checked: number): string {
  const n = formatCount(checked);
  switch (goal.metric) {
    case 'doubleCharges':
      return `Every fault schedule was checked; with no faults that is ${n} ${checked === 1 ? 'payment' : 'payments'}. Not checked: a payment the client was told failed that was charged anyway.`;
    case 'lostAckedWrites':
      return `Every fault schedule was checked; with no faults that is ${n} ${checked === 1 ? 'write' : 'writes'} the client was told ${checked === 1 ? 'was' : 'were'} saved.`;
    case 'staleReads':
      return `Every fault schedule was checked; with no faults that is ${n} ${checked === 1 ? 'read' : 'reads'} from stores whose reads trail their writes.`;
    default:
      return '';
  }
}

/** The log keeps so many requests; past them a run is only partly checked. */
export const TRUNCATED_LINE =
  'Not every request was checked: this design sends more than the 1,048,576 requests one check can follow, and the ones after that were left out.';

/**
 * For a held double-charge goal where nothing on the way to a charge
 * retries: why it held, so it is not read as the work of idempotency.
 */
export function nothingRetriesLine(charged: readonly string[], names: Names): string {
  const parts = listed(charged.map(names.node));
  return `Nothing on the way to ${parts} sends a call again, and no cable was tried delivering a call twice, so nothing tried could charge twice. Turn on retries before it, or let the search deliver requests twice, to test it.`;
}

/**
 * Why a goal picked earlier is no longer offered, by its template id: the
 * part it was about has gone from the design.
 */
export function goneLine(id: string): string {
  switch (id.split(':')[0]) {
    case 'saved':
      return 'Nothing in the design says a write is saved before it is any more, so no saved write can be lost this way.';
    case 'jobs':
      return 'Nothing in the design holds jobs for workers any more, so no job can be lost this way.';
    case 'fresh':
      return 'No store in the design serves reads that trail its writes any more, so no read can miss a write this way.';
    case 'once':
      return 'No part of the design can charge money any more.';
    default:
      return 'That traffic source is gone.';
  }
}
