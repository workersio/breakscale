import { ShareLinkTooLargeError, buildShareUrl } from '../../src/share';
import type { AttackKind } from '../../src/sim/breakit';
import { verifySteps } from '../../src/sim/verify';
import type { Verdict, VerifyGoal, VerifyOptions } from '../../src/sim/verify';
import type { FailureReason, Topology } from '../../src/sim/types';
import {
  baselineSentence,
  closestLine,
  effectSentence,
  goalLine,
  scheduleSentence,
  singlePointLines,
  triedLine,
} from '../../src/components/breakCopy';
import type { Names } from '../../src/components/breakCopy';
import { REASON_WORDS } from './run';

/* ------------------------------------------------------------------ *
 * The break_it tool: the "Can you break it?" search, said in words.
 *
 * The verdict is the headless verify's, which is the panel's search, so
 * the sentences are the panel's too (breakCopy), with each part named by
 * its label and the caller's id so the model can point at it.
 *
 * Two limits keep a call short, and both are deterministic: schedules
 * tried and simulated seconds played. The same request gets the same
 * answer on a laptop and on the hosted server. The wall clock is only an
 * emergency stop for a design heavy enough to blow through both, and then
 * the answer is that it stopped, never a verdict that depends on speed.
 * ------------------------------------------------------------------ */

export interface BreakLimits {
  /** Most schedules one call tries; also the default. */
  maxBudget: number;
  /** Simulated seconds after which no new schedule starts. */
  maxSimSeconds: number;
  /** Wall-clock emergency stop, ms. */
  wallMs: number;
}

/** Running on the caller's own machine. */
export const LOCAL_BREAK: BreakLimits = {
  maxBudget: 200,
  maxSimSeconds: 7500,
  wallMs: 60_000,
};

/*
 * The hosted server. 40 schedules is about 1500 simulated seconds. Over
 * every preset with an error goal and a p99 goal, a call took 3.0s at
 * worst (spotify, p99) and most under 1.5s, on an M-series laptop.
 */
export const HOSTED_BREAK: BreakLimits = {
  maxBudget: 40,
  maxSimSeconds: 1500,
  wallMs: 10_000,
};

/**
 * As a caller sends it. Strings and numbers are checked by the search's own
 * `verifyErrors`, which says what is wrong in words.
 */
export interface BreakRequest {
  goal: { metric: string; max: number; route?: string };
  kinds?: string[];
  maxFaults?: number;
  budget?: number;
  seed?: number;
  includeSinglePoints?: boolean;
}

export type BreakOutcome =
  { ok: false; errors: string[] } | { ok: true; text: string; verdict: Verdict | null };

/** Parts by label and id: "Database (id 'db')". */
export function namesFor(design: Topology): Names {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const node = (id: string) => {
    const label = byId.get(id)?.label;
    return label && label !== id ? `${label} (id '${id}')` : `'${id}'`;
  };
  return {
    node,
    edge: (id: string) => {
      const e = design.edges.find((x) => x.id === id);
      return e ? `the cable from ${node(e.from)} to ${node(e.to)}` : `'${id}'`;
    },
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function failures(byReason: Partial<Record<FailureReason, number>>): string | null {
  const reasons = (Object.entries(byReason) as [FailureReason, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (reasons.length === 0) return null;
  return (
    'Failed requests in that window: ' +
    reasons.map(([r, n]) => `${n} ${REASON_WORDS[r] ?? r}`).join('; ') +
    '.'
  );
}

/** Search the design for a schedule of faults that misses the goal, and say what happened. */
export async function breakDesign(
  design: Topology,
  req: BreakRequest,
  limits: BreakLimits,
  appUrl: string,
): Promise<BreakOutcome> {
  const lines: string[] = [];
  let budget = req.budget ?? limits.maxBudget;
  if (budget > limits.maxBudget) {
    lines.push(
      `The budget was cut from ${req.budget} to ${limits.maxBudget} schedules, the most this server tries in one call.`,
    );
    budget = limits.maxBudget;
  }
  // Unchecked until verifySteps runs verifyErrors over them.
  const goal: VerifyGoal = {
    metric: req.goal.metric as VerifyGoal['metric'],
    max: req.goal.max,
    ...(req.goal.route !== undefined ? { route: req.goal.route } : {}),
  };
  const opts: VerifyOptions = {
    budget,
    maxSimSeconds: limits.maxSimSeconds,
    ...(req.kinds !== undefined ? { kinds: req.kinds as AttackKind[] } : {}),
    ...(req.maxFaults !== undefined ? { maxFaults: req.maxFaults as 1 | 2 | 3 } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.includeSinglePoints !== undefined
      ? { includeSinglePoints: req.includeSinglePoints }
      : {}),
  };

  const it = verifySteps(design, goal, opts);
  const start = performance.now();
  let verdict: Verdict;
  let tried = 0;
  for (;;) {
    const step = it.next();
    if (step.done) {
      verdict = step.value;
      break;
    }
    tried = step.value.tried;
    if (performance.now() - start > limits.wallMs) {
      lines.push(
        `Stopped after ${plural(tried, 'schedule', 'schedules')} without an answer: the design is too heavy to search here in one call. ` +
          'A smaller budget, fewer fault kinds or maxFaults 1 makes it lighter.',
      );
      return { ok: true, text: lines.join('\n'), verdict: null };
    }
  }
  if (verdict.status === 'invalid') return { ok: false, errors: verdict.errors };

  const names = namesFor(design);
  if ((design.faults?.length ?? 0) > 0) {
    lines.push("The design's own faults were left out; the search picks its own.");
  }

  switch (verdict.status) {
    case 'alreadyBroken': {
      const m = verdict.measured;
      lines.push(
        `It already misses the goal with no faults, on seed ${m.seed}. ${effectSentence(m, goal, names)} ${goalLine(goal, m)}`,
      );
      const why = failures(m.failuresByReason);
      if (why) lines.push(why);
      break;
    }
    case 'held': {
      if (verdict.tried === 0) {
        lines.push(
          'Nothing was tried, so this is not a pass: with these options no fault can land anywhere in the design.',
        );
        break;
      }
      lines.push(
        `Held. Tried ${plural(verdict.tried, 'fault schedule', 'fault schedules')} over ${Math.round(verdict.simSeconds)} simulated seconds. ${triedLine(verdict.bySize)}`,
        'Each fault started between 10s and 15s, and the goal was measured from 5s to 35s.',
      );
      if (verdict.stoppedBy === 'simSeconds') {
        lines.push(
          `It stopped at this server's limit of ${limits.maxSimSeconds} simulated seconds.`,
        );
      } else if (verdict.stoppedBy === 'exhausted') {
        lines.push('There were no more schedules to try with these options.');
      } else if (verdict.tried < budget) {
        lines.push(
          `That used the part of the budget these options allow: ${verdict.tried} of ${budget} schedules.` +
            (opts.maxFaults === 1
              ? ' With maxFaults 2 or 3 the rest goes to faults together.'
              : ''),
        );
      } else if (budget < limits.maxBudget) {
        lines.push(
          `That was the whole budget. Up to ${limits.maxBudget} schedules can be tried.`,
        );
      }
      const c = verdict.closest;
      // closestLine's "yet" is for the panel's live progress; this answer is final.
      lines.push(
        c === null || c.score < 0.5
          ? 'No schedule came close.'
          : closestLine({ ...c, attacks: c.schedule }, goal, names),
      );
      break;
    }
    case 'broken': {
      const size = verdict.schedule.length;
      lines.push(
        `Broke it with ${size === 1 ? 'one fault' : size === 2 ? 'two faults' : 'three faults'}, found on schedule ${verdict.tried}` +
          (verdict.shrinkTried > 0
            ? ` and made smaller in ${verdict.shrinkTried} more.`
            : '.'),
        scheduleSentence(verdict.schedule, names),
        `${effectSentence(verdict.measured, goal, names)} ${goalLine(goal, verdict.measured)} ${baselineSentence(verdict.withoutFaults, goal, names)}`,
      );
      const why = failures(verdict.measured.failuresByReason);
      if (why) lines.push(why);
      lines.push(
        `It broke on seed ${verdict.measured.seed} and on another seed too. ` +
          (verdict.minimal
            ? 'No smaller schedule breaks it.'
            : 'A smaller schedule might still break it.'),
      );
      try {
        lines.push(
          '',
          `Replay link, which plays the same run on breakscale.tech: ${await buildShareUrl(verdict.replay, appUrl)}`,
        );
      } catch (err) {
        if (!(err instanceof ShareLinkTooLargeError)) throw err;
        lines.push(
          '',
          `The design is too large for a replay link. Passing it to create_view with seed ${verdict.measured.seed} and these faults plays the same run: ${JSON.stringify(verdict.faults)}`,
        );
      }
      break;
    }
  }

  const points = singlePointLines(verdict.singlePoints, names);
  if (points.length > 0) {
    lines.push('', 'Single points of failure:', ...points);
    if (!req.includeSinglePoints && verdict.status !== 'alreadyBroken') {
      lines.push(
        'Losing one of these breaks any goal, so the search never crashed, failed or cut them whole. It could still slow them and take down single machines. includeSinglePoints true crashes and cuts them too.',
      );
    }
  }
  return { ok: true, text: lines.join('\n'), verdict };
}
