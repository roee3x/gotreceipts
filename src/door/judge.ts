import { judgeApproval, type ApprovalDecision } from '../approval/judge.ts';
import { policyFor, type PolicyChoice, type PolicySource, type Target } from '../policy/committed.ts';
import { policyId } from '../policy/hash.ts';
import { tierForBranch, type Policy, type Tier } from '../policy/policy.ts';
import { readRecords } from '../record/store.ts';
import { decide, type Decision } from '../verify/decide.ts';

/**
 * The one question this tool asks: may this commit enter this branch?
 *
 * It is answered in four steps, always in this order:
 *
 *   1. Which policy counts? The one that is already on the branch, not the commit's own copy.
 *   2. Which level does that policy ask of the branch?
 *   3. Does the commit have a valid record at that level?
 *   4. Does it need a signed approval, and does it have a valid one?
 *
 * Steps 1 and 2 give the rules: `rulesFor`. Steps 3 and 4 give the proof: `proofOf`.
 * They are two functions because a door may have something to do in between. The merge
 * command, for one, first asks the remote for records that were made in another clone.
 *
 * "verify", the push hook, "merge", "approve" and "audit" all ask here, and nowhere else.
 * So they cannot disagree about the same commit: there is only one copy of each step.
 * What a door does with the answer is its own: refuse a push, refuse a merge, or only report.
 */

/** The rules a commit is judged by when it wants to enter a branch. */
export interface Rules {
  readonly policy: Policy;
  /** Where that policy came from, and what the commit would change that is protected. */
  readonly source: PolicySource;
  /** What the policy asks of the branch. Undefined when no branch is named, or the policy sets no level for it. */
  readonly tier: Tier | undefined;
}

export type RulesChoice = ({ readonly ok: true } & Rules) | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Step 2, on top of an answer of step 1: what the policy asks of the branch.
 *
 * It is a function of its own for the push hook, which is given the commit of the target
 * branch by git and so has its own way of asking step 1.
 */
export function withTier(picked: PolicyChoice, branch: string | undefined): RulesChoice {
  if (!picked.ok) return picked;
  return { ...picked, tier: branch === undefined ? undefined : tierForBranch(picked.policy, branch) };
}

/**
 * Steps 1 and 2: the rules for `commit` when it enters `target`.
 * Without a target no branch is entered, and the policy is the one in the commit itself.
 */
export function rulesFor(root: string, commit: string, target: Target | undefined): RulesChoice {
  return withTier(policyFor(root, commit, target), target?.branch);
}

/** What is asked about one commit. */
export interface Ask {
  readonly commit: string;
  /** The level its record must satisfy. */
  readonly level: string;
  /** The branch it wants to enter. Undefined when only a level was asked about. */
  readonly branch: string | undefined;
  /** The time the question is asked for, in milliseconds. A record and an approval each count only for a while. */
  readonly now: number;
}

/** What a commit has to show for itself. */
export interface Proof {
  /** The answer of step 3. */
  readonly record: Decision;
  /** Files in the commit's record folder that are not valid records. They were ignored, and are named. */
  readonly unreadable: readonly string[];
  /** The answer of step 4. */
  readonly approval: ApprovalDecision;
}

/** Step 3: whether the records of the commit satisfy the level. */
function recordOf(root: string, policy: Policy, ask: Ask): Pick<Proof, 'record' | 'unreadable'> {
  const stored = readRecords(root, ask.commit);
  const record = decide({ policy, policyId: policyId(policy), requiredLevel: ask.level, records: stored.records, now: ask.now });
  return { record, unreadable: stored.unreadable };
}

/**
 * Step 4: whether the commit needs an approval to enter the branch, and whether it has a valid one.
 * An approval is about entering a branch, so without a branch nothing can ask for one.
 *
 * "gate" asks this step alone. It runs the checks and judges no record, and it says early
 * when the commit will need a signature at the door.
 */
export function approvalOf(root: string, rules: Pick<Rules, 'policy' | 'source'>, ask: Omit<Ask, 'level'>): ApprovalDecision {
  if (ask.branch === undefined) return { kind: 'not-needed' };
  return judgeApproval(root, rules.policy, rules.source, ask.commit, ask.branch, ask.now);
}

/** Steps 3 and 4: what `ask.commit` has to show, judged by `rules`. It reads, and changes nothing. */
export function proofOf(root: string, rules: Pick<Rules, 'policy' | 'source'>, ask: Ask): Proof {
  return { ...recordOf(root, rules.policy, ask), approval: approvalOf(root, rules, ask) };
}
