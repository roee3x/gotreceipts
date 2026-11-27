import { isUtcTime } from '../clock.ts';
import { isFullId } from '../git.ts';
import { isObject } from '../json.ts';

/**
 * The approval: one sentence, written as a small file and signed.
 *
 *   "I approve exactly this commit into exactly this branch, at this time."
 *
 * It names one commit and one branch. A new commit, or another branch, needs a new approval.
 * For how long it counts is said by the policy on the branch, not by the approval itself.
 *
 * Like a record, it is safe to show: it holds no folder path, no machine name and no user name.
 * Who signed is not written in it. That is read from the signature, which cannot be made up.
 */
export interface Approval {
  readonly schema: 1;
  readonly kind: 'approval';
  readonly tool: { readonly name: 'gotreceipts'; readonly version: string };
  /** The full id of the commit that is approved. */
  readonly commit: string;
  /** The branch it is approved into. */
  readonly branch: string;
  /** The time of the approval, in UTC, in the form 2026-01-31T12:00:00.000Z. */
  readonly approvedAt: string;
}

/**
 * What the signature is made for. A signature made for another purpose with the same key,
 * such as a signed git commit, is not accepted as an approval.
 */
export const APPROVAL_NAMESPACE = 'gotreceipts-approval';

export function newApproval(commit: string, branch: string, version: string, now: number): Approval {
  return {
    schema: 1,
    kind: 'approval',
    tool: { name: 'gotreceipts', version },
    commit,
    branch,
    approvedAt: new Date(now).toISOString(),
  };
}

/** The text that is signed and kept. The signature is over exactly these bytes. */
export function approvalText(approval: Approval): string {
  return `${JSON.stringify(approval, null, 2)}\n`;
}

export type ApprovalParse =
  | { readonly ok: true; readonly approval: Approval }
  | { readonly ok: false; readonly error: string };

const ENTRIES = ['schema', 'kind', 'tool', 'commit', 'branch', 'approvedAt'];

/** Reads an approval. Strict, like the reader of the policy: anything unexpected is an error. */
export function parseApproval(text: string): ApprovalParse {
  const not = (error: string): ApprovalParse => ({ ok: false, error });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return not('it is not valid JSON');
  }
  if (!isObject(raw)) return not('it does not hold a JSON object');

  const unknown = Object.keys(raw).find((key) => !ENTRIES.includes(key));
  if (unknown !== undefined) return not(`it holds an unknown entry, "${unknown}"`);
  if (raw['schema'] !== 1) return not('its schema number is not 1');
  if (raw['kind'] !== 'approval') return not('it is not an approval');

  const { tool, commit, branch, approvedAt } = raw;
  if (!isObject(tool) || tool['name'] !== 'gotreceipts' || typeof tool['version'] !== 'string') {
    return not('it does not say which tool wrote it');
  }
  if (typeof commit !== 'string' || !isFullId(commit)) return not('it does not name a commit by its full id');
  if (typeof branch !== 'string' || branch === '') return not('it does not name a branch');
  if (typeof approvedAt !== 'string' || !isUtcTime(approvedAt)) return not('it does not say when it was given');

  return { ok: true, approval: { schema: 1, kind: 'approval', tool: { name: 'gotreceipts', version: tool['version'] }, commit, branch, approvedAt } };
}
