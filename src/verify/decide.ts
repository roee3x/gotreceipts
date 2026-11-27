import { hoursSince, isInTheFuture, shownAge } from '../clock.ts';
import { checksForLevel, levelRank, type Policy } from '../policy/policy.ts';
import type { GateRecord } from '../record/record.ts';

/** Why a record that was looked at does not count, as a code. */
export type RecordProblem =
  | 'other-policy'
  | 'below-level'
  | 'failed'
  | 'from-the-future'
  | 'too-old'
  /** It would count, and a newer run failed after it. */
  | 'failed-since';

/** One record that was looked at, and why it does not count. */
export interface Looked {
  /** Which record it is: "G1 record, passed 2.0 hours ago". */
  readonly about: string;
  /** The reason as a code, for a caller that says it in words of its own. */
  readonly problem: RecordProblem;
  /** The reason as a sentence. */
  readonly sentence: string;
}

/** The line about one record that does not count: "G1 record, passed 2.0 hours ago: its level is below G2". */
export function detailOf(looked: Pick<Looked, 'about' | 'sentence'>): string {
  return `${looked.about}: ${looked.sentence}`;
}

export type Decision =
  | {
      readonly ok: true;
      /** The record that satisfies the request. */
      readonly record: GateRecord;
      readonly ageHours: number;
    }
  | {
      readonly ok: false;
      /** One sentence for the verdict line. */
      readonly summary: string;
      /** Every record that was looked at, newest first. Empty when there is no record. */
      readonly looked: readonly Looked[];
      /** The same, as one line each. */
      readonly details: readonly string[];
    };

export interface DecideInput {
  readonly policy: Policy;
  /** The id of the policy as it is now. */
  readonly policyId: string;
  /** The level the commit needs. */
  readonly requiredLevel: string;
  /** Every valid record of the commit. */
  readonly records: readonly GateRecord[];
  /** The current time, in milliseconds. */
  readonly now: number;
}

function finishedAt(record: GateRecord): number {
  return Date.parse(record.finishedAt);
}

function ageHours(record: GateRecord, now: number): number {
  return hoursSince(finishedAt(record), now);
}

function describe(record: GateRecord, now: number): string {
  const verb = record.result === 'pass' ? 'passed' : 'failed';
  return `${record.level} record, ${verb} ${shownAge(ageHours(record, now))} hours ago`;
}

type Problem = Pick<Looked, 'problem' | 'sentence'>;

/**
 * Says why a record cannot satisfy the request, or undefined when it can.
 * The reasons are checked in a fixed order, and the first one that applies is given.
 */
function problemWith(record: GateRecord, input: DecideInput): Problem | undefined {
  const { policy, policyId, requiredLevel, now } = input;

  if (record.policyId !== policyId) {
    return { problem: 'other-policy', sentence: 'it was made under a different policy than the current one' };
  }
  const rank = levelRank(policy, record.level);
  if (rank === -1 || rank < levelRank(policy, requiredLevel)) {
    return { problem: 'below-level', sentence: `its level is below ${requiredLevel}` };
  }
  if (record.result !== 'pass') {
    return { problem: 'failed', sentence: record.reason };
  }
  if (isInTheFuture(finishedAt(record), now)) {
    return { problem: 'from-the-future', sentence: 'it is dated in the future' };
  }
  if (ageHours(record, now) > policy.record.maxAgeHours) {
    return { problem: 'too-old', sentence: `it is older than the ${policy.record.maxAgeHours} hours a record counts for` };
  }
  return undefined;
}

/**
 * True when a failed run takes away what an older passing record showed.
 *
 * It does when it was made under the current policy and one of the checks it failed is a check
 * the required level needs. A failure in a check that only a higher level adds does not count
 * against the lower level. A failure with no failed check (the files changed during the run)
 * always counts.
 */
function cancels(failure: GateRecord, input: DecideInput): boolean {
  if (failure.result !== 'fail' || failure.policyId !== input.policyId) return false;
  const needed = new Set((checksForLevel(input.policy, input.requiredLevel) ?? []).map((check) => check.name));
  const failedChecks = failure.checks.filter((check) => check.status === 'fail');
  if (failedChecks.length === 0) return true;
  return failedChecks.some((check) => needed.has(check.name));
}

function refused(summary: string, looked: readonly Looked[]): Decision {
  return { ok: false, summary, looked, details: looked.map(detailOf) };
}

/**
 * Decides whether a commit has what it needs: a record that passed, at the required level or a
 * higher one, made under the current policy, still fresh, and not followed by a newer failure.
 *
 * This function reads nothing and runs nothing. It is given everything, including the time,
 * so every rule in it can be tested exactly.
 */
export function decide(input: DecideInput): Decision {
  const { requiredLevel, now } = input;
  const newestFirst = [...input.records].sort((a, b) => finishedAt(b) - finishedAt(a));
  if (newestFirst.length === 0) return refused('there is no record for this commit', []);

  // 1. The newest record that can satisfy the request.
  const judged = newestFirst.map((record) => ({ record, problem: problemWith(record, input) }));
  const candidate = judged.find((each) => each.problem === undefined)?.record;
  if (candidate === undefined) {
    const looked = judged.flatMap(({ record, problem }) => (problem === undefined ? [] : [{ about: describe(record, now), ...problem }]));
    return refused(`no record of this commit satisfies level ${requiredLevel}`, looked);
  }

  // 2. A newer run that failed takes it away again.
  const newerFailure = newestFirst.find((record) => finishedAt(record) > finishedAt(candidate) && cancels(record, input));
  if (newerFailure !== undefined) {
    return refused(`the newest run that matters for level ${requiredLevel} failed`, [
      { about: describe(candidate, now), problem: 'failed-since', sentence: 'a newer run failed after it' },
      { about: describe(newerFailure, now), problem: 'failed', sentence: newerFailure.reason },
    ]);
  }

  return { ok: true, record: candidate, ageHours: ageHours(candidate, now) };
}
