import { policyId } from '../policy/hash.ts';
import type { Policy } from '../policy/policy.ts';
import { readRecords } from '../record/store.ts';
import { decide, type Decision } from './decide.ts';

export interface Judgement {
  readonly decision: Decision;
  /** Files in the commit's record folder that are not valid records. They were ignored, and are named. */
  readonly unreadable: readonly string[];
}

/**
 * Reads the records of one commit and decides whether they satisfy a level.
 *
 * This is the one question the whole tool asks. The verify command, the push hook and the
 * merge command all ask it here, so they can never disagree about the same record.
 */
export function judgeCommit(root: string, policy: Policy, commit: string, requiredLevel: string, now: number): Judgement {
  const stored = readRecords(root, commit);
  const decision = decide({ policy, policyId: policyId(policy), requiredLevel, records: stored.records, now });
  return { decision, unreadable: stored.unreadable };
}
