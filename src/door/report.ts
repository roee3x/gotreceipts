import type { ApprovalDecision } from '../approval/judge.ts';
import { shownAge } from '../clock.ts';
import { shortId } from '../git.ts';
import { sourceLines, type PolicySource } from '../policy/committed.ts';
import type { Decision } from '../verify/decide.ts';
import type { Proof } from './judge.ts';

/**
 * What the doors say about an answer of the one question.
 *
 * The judging is in judge.ts. Here an answer is only put into words, so that "verify", the
 * push hook, "merge" and "approve" say the same thing in the same words. Each of them lays
 * the lines out in its own way: how far they are moved in, and what stands around them.
 */

// --- step 1: the policy ---

export interface PolicyWords {
  /** Which policy was used: "the one on origin/main, at commit 1a2b3c4". */
  readonly which: string;
  /** What else there is to say: that the commit changes the policy file, and which protected files would change. */
  readonly notes: readonly string[];
}

export function policyWords(source: PolicySource): PolicyWords {
  const [which = '', ...notes] = sourceLines(source);
  return { which, notes };
}

/** The same as lines: "policy: the one on origin/main, at commit 1a2b3c4", then the notes. */
export function policyLines(source: PolicySource): string[] {
  const { which, notes } = policyWords(source);
  return [`policy: ${which}`, ...notes];
}

// --- step 3: the record ---

type Passed = Extract<Decision, { ok: true }>;

/** "G1 record, passed 0.2 hours ago". */
export function passedRecord(record: Passed): string {
  return `${record.record.level} record, passed ${shownAge(record.ageHours)} hours ago`;
}

/** The record that counts, as a line of its own. */
export function countedRecord(record: Passed): string {
  return `${passedRecord(record)}, under the current policy`;
}

/** A file in the commit's record folder that is not a record. It was not used, and that is said. */
export function ignoredLine(file: string): string {
  return `ignored, not a valid record: ${file}`;
}

/**
 * What there is to say about the record: first the files that were ignored, then the record
 * that counts, or one line for every record that was looked at and does not.
 */
export function recordLines(proof: Pick<Proof, 'record' | 'unreadable'>): string[] {
  const { record, unreadable } = proof;
  return [...unreadable.map(ignoredLine), ...(record.ok ? [countedRecord(record)] : record.details)];
}

/** The command that makes a missing record, and where to run it when the commit is not the one that is checked out. */
export function gateAdvice(branch: string, commit: string, checkedOut: string | undefined): string {
  return `gotreceipts gate --for ${branch}${commit === checkedOut ? '' : `   (with commit ${shortId(commit)} checked out)`}`;
}

// --- step 4: the approval ---

function needed(reasons: readonly string[]): string {
  return `approval: needed, because ${reasons.join(', and ')}`;
}

/** Said when an approval is needed and it could not be found out whether there is a valid one. That is never a pass. */
export function approvalNotChecked(reason: string): string {
  return `the approval could not be checked: ${reason}`;
}

/** What there is to say about the approval. Nothing, when the commit needs none. */
export function approvalLines(approval: ApprovalDecision): string[] {
  switch (approval.kind) {
    case 'not-needed':
      return [];
    case 'not-locked':
      return ['approval: not asked for. The policy lists no signer, so a change to a protected file needs nobody\'s signature'];
    case 'approved':
      return [needed(approval.reasons), `approved by ${approval.signer}, ${shownAge(approval.ageHours)} hours ago`];
    case 'refused':
      return [needed(approval.reasons), approval.detail];
    case 'cannot-check':
      return [needed(approval.reasons), approvalNotChecked(approval.reason)];
  }
}

/** The verdict of a commit that has its record and lacks its approval. */
export function recordButNoApproval(commit: string, branch: string): string {
  return `commit ${shortId(commit)} has its record, and no valid approval for "${branch}"`;
}

/** A commit that still needs an approval, and the branch it is needed for. */
export interface Unapproved {
  readonly commit: string;
  readonly branch: string;
}

/** What to do about a missing approval. The agent cannot do it, and the wording says so. */
export function approvalAdvice(...unapproved: readonly Unapproved[]): string[] {
  return [
    'An approval is the signature of an owner. They give it in their own terminal:',
    ...unapproved.map(({ commit, branch }) => `  gotreceipts approve ${shortId(commit)} --for ${branch}`),
  ];
}
