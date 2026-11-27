import { hoursSince, isInTheFuture } from '../clock.ts';
import type { PolicySource } from '../policy/committed.ts';
import { tierForBranch, type Policy } from '../policy/policy.ts';
import { checkSignature } from './ssh.ts';
import { parseApproval } from './statement.ts';
import { readApprovalFiles } from './store.ts';

export type ApprovalDecision =
  /** The commit may enter the branch without an approval. */
  | { readonly kind: 'not-needed' }
  /**
   * The commit would change a protected file, and the policy lists no signer. Nobody can be
   * asked, so nothing is refused. The lock is open until a first key is listed.
   */
  | { readonly kind: 'not-locked' }
  | { readonly kind: 'approved'; readonly reasons: readonly string[]; readonly signer: string; readonly ageHours: number }
  | { readonly kind: 'refused'; readonly reasons: readonly string[]; readonly detail: string }
  /** It needs an approval, and whether it has one could not be found out. Never a pass. */
  | { readonly kind: 'cannot-check'; readonly reasons: readonly string[]; readonly reason: string };

/**
 * Why a commit needs an approval before it may enter a branch. An empty list: it needs none.
 *
 * Two things ask for one. The branch itself, when the policy says that every commit into it
 * needs an approval. And a change to a protected file, on every branch that has a level.
 */
function reasonsFor(policy: Policy, branch: string, source: PolicySource): string[] {
  const tier = tierForBranch(policy, branch);
  if (tier === undefined) return [];
  const reasons: string[] = [];
  if (tier.needsApproval === true) reasons.push(`every commit that enters "${branch}" needs one`);
  const changed = source.kind === 'target' ? source.protectedChanged.length : 0;
  if (changed > 0) reasons.push(`it would change ${changed === 1 ? 'a protected file' : `${changed} protected files`}`);
  return reasons;
}

/**
 * Decides whether a commit needs an approval to enter a branch, and whether it has a valid one.
 *
 * This is step 4 of the one question, and it is asked through the door only (door/judge.ts).
 *
 * `policy` and `source` are the policy the commit is judged by: the one on the target branch.
 * So the keys that count are the ones listed there. A commit cannot name its own signer.
 */
export function judgeApproval(
  root: string,
  policy: Policy,
  source: PolicySource,
  commit: string,
  branch: string,
  now: number,
): ApprovalDecision {
  const reasons = reasonsFor(policy, branch, source);
  if (reasons.length === 0) return { kind: 'not-needed' };
  // A branch can only ask for an approval when a signer is listed (the reader of the policy
  // sees to that), so without one the only reason left is a protected file.
  if (policy.approval === undefined) return { kind: 'not-locked' };
  const { signers, maxAgeHours } = policy.approval;

  const files = readApprovalFiles(root, commit, branch);
  if (files === undefined) return { kind: 'refused', reasons, detail: `there is no approval of this commit for "${branch}"` };
  const doesNotCount = (why: string): ApprovalDecision => ({ kind: 'refused', reasons, detail: `the approval that is there does not count: ${why}` });

  // The signature first. Until it is checked, nothing the file says is believed.
  const signature = checkSignature(signers, files.statement, files.signatureFile);
  if (signature.kind === 'cannot-check') return { kind: 'cannot-check', reasons, reason: signature.reason };
  if (signature.kind === 'bad') return doesNotCount(signature.reason);

  // Then what was signed: this commit, into this branch.
  const parsed = parseApproval(files.statement.toString('utf8'));
  if (!parsed.ok) return doesNotCount(parsed.error);
  const { approval } = parsed;
  if (approval.commit !== commit) return doesNotCount('it approves another commit');
  if (approval.branch !== branch) return doesNotCount('it approves another branch');

  // And when. An approval counts for as long as the policy says, and not before it was given.
  const approvedAt = Date.parse(approval.approvedAt);
  if (isInTheFuture(approvedAt, now)) return doesNotCount('it is dated in the future');
  const ageHours = hoursSince(approvedAt, now);
  if (ageHours > maxAgeHours) return doesNotCount(`it is older than the ${maxAgeHours} hours an approval counts for`);

  return { kind: 'approved', reasons, signer: signature.signer, ageHours };
}
