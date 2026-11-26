import { checksForLevel, levelRank, type Policy } from '../policy/policy.ts';
import type { GateRecord } from '../record/record.ts';

/** How far ahead of the clock a record may be dated before it is distrusted. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

export type Decision =
  | {
      readonly ok: true;
      /** The record that satisfies the request. */
      readonly record: GateRecord;
      readonly ageHours: number;
    }
  | {
      readonly ok: false;
      /** One line per record that was looked at, saying why it does not count. Empty when there is no record. */
      readonly details: readonly string[];
      /** One sentence for the verdict line. */
      readonly summary: string;
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

function ageHours(record: GateRecord, now: number): number {
  return (now - Date.parse(record.finishedAt)) / 3_600_000;
}

/** The age as it is shown. A record dated a little ahead of the clock is shown as 0.0, not as a negative age. */
export function shownAge(hours: number): string {
  return Math.max(0, hours).toFixed(1);
}

function describe(record: GateRecord, now: number): string {
  const verb = record.result === 'pass' ? 'passed' : 'failed';
  return `${record.level} record, ${verb} ${shownAge(ageHours(record, now))} hours ago`;
}

/**
 * Says why a record cannot satisfy the request, or undefined when it can.
 * The reasons are checked in a fixed order, and the first one that applies is given.
 */
function problemWith(record: GateRecord, input: DecideInput): string | undefined {
  const { policy, policyId, requiredLevel, now } = input;

  if (record.policyId !== policyId) {
    return 'it was made under a different policy than the current one';
  }
  const rank = levelRank(policy, record.level);
  if (rank === -1 || rank < levelRank(policy, requiredLevel)) {
    return `its level is below ${requiredLevel}`;
  }
  if (record.result !== 'pass') {
    return record.reason;
  }
  const finished = Date.parse(record.finishedAt);
  if (finished > now + CLOCK_TOLERANCE_MS) {
    return 'it is dated in the future';
  }
  const hours = ageHours(record, now);
  if (hours > policy.record.maxAgeHours) {
    return `it is older than the ${policy.record.maxAgeHours} hours a record counts for`;
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

/**
 * Decides whether a commit has what it needs: a record that passed, at the required level or a
 * higher one, made under the current policy, still fresh, and not followed by a newer failure.
 *
 * This function reads nothing and runs nothing. It is given everything, including the time,
 * so every rule in it can be tested exactly.
 */
export function decide(input: DecideInput): Decision {
  const { requiredLevel, now } = input;
  const newestFirst = [...input.records].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));

  if (newestFirst.length === 0) {
    return { ok: false, details: [], summary: 'there is no record for this commit' };
  }

  const candidate = newestFirst.find((record) => problemWith(record, input) === undefined);

  if (candidate === undefined) {
    const details = newestFirst.map((record) => `${describe(record, now)}: ${problemWith(record, input) ?? ''}`);
    return { ok: false, details, summary: `no record of this commit satisfies level ${requiredLevel}` };
  }

  const newerFailure = newestFirst.find(
    (record) => Date.parse(record.finishedAt) > Date.parse(candidate.finishedAt) && cancels(record, input),
  );
  if (newerFailure !== undefined) {
    return {
      ok: false,
      details: [
        `${describe(candidate, now)}: a newer run failed after it`,
        `${describe(newerFailure, now)}: ${newerFailure.reason}`,
      ],
      summary: `the newest run that matters for level ${requiredLevel} failed`,
    };
  }

  return { ok: true, record: candidate, ageHours: ageHours(candidate, now) };
}
