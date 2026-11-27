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

const SHA = /^[0-9a-f]{40,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEYS = ['schema', 'kind', 'tool', 'commit', 'branch', 'approvedAt'];

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

/** Reads an approval. Strict, like the reader of the policy: anything unexpected is an error. */
export function parseApproval(text: string): ApprovalParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'it is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'it does not hold a JSON object' };
  const value = raw as Record<string, unknown>;

  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown !== undefined) return { ok: false, error: `it holds an unknown entry, "${unknown}"` };
  if (value['schema'] !== 1) return { ok: false, error: 'its schema number is not 1' };
  if (value['kind'] !== 'approval') return { ok: false, error: 'it is not an approval' };

  const tool = value['tool'];
  if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) return { ok: false, error: 'it does not say which tool wrote it' };
  const { name, version } = tool as Record<string, unknown>;
  if (name !== 'gotreceipts' || typeof version !== 'string') return { ok: false, error: 'it does not say which tool wrote it' };

  const { commit, branch, approvedAt } = value;
  if (typeof commit !== 'string' || !SHA.test(commit)) return { ok: false, error: 'it does not name a commit by its full id' };
  if (typeof branch !== 'string' || branch === '') return { ok: false, error: 'it does not name a branch' };
  if (typeof approvedAt !== 'string' || !TIME.test(approvedAt) || Number.isNaN(Date.parse(approvedAt))) {
    return { ok: false, error: 'it does not say when it was given' };
  }

  return { ok: true, approval: { schema: 1, kind: 'approval', tool: { name: 'gotreceipts', version }, commit, branch, approvedAt } };
}
