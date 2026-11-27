import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { storeFolder, storeLabel, writeWhole } from '../store.ts';

/**
 * Where approvals are kept: "approvals" in the tool's folder inside .git, next to the records.
 * One approval per commit and branch. A newer one replaces the older one.
 *
 * An approval is two files: the statement, and its signature under the same name plus ".sig".
 */
function approvalsFolder(root: string): string | undefined {
  const store = storeFolder(root);
  return store === undefined ? undefined : join(store, 'approvals');
}

/** A branch name as a file name. A branch may hold a slash, and a file name may not. */
function fileNameOf(branch: string): string {
  return `${encodeURIComponent(branch)}.json`;
}

/** How an approval's place is shown to the user: without the machine's folders in front of it. */
export function approvalLabel(commit: string, branch: string): string {
  return storeLabel('approvals', commit, fileNameOf(branch));
}

export interface ApprovalFiles {
  /** The statement, as the exact bytes that were signed. */
  readonly statement: Buffer;
  /** The file that holds the signature. */
  readonly signatureFile: string;
}

/** The approval of one commit into one branch, or undefined when there is none. */
export function readApprovalFiles(root: string, commit: string, branch: string): ApprovalFiles | undefined {
  const folder = approvalsFolder(root);
  if (folder === undefined) return undefined;
  const statementFile = join(folder, commit, fileNameOf(branch));
  const signatureFile = `${statementFile}.sig`;
  if (!existsSync(statementFile) || !existsSync(signatureFile)) return undefined;
  try {
    return { statement: readFileSync(statementFile), signatureFile };
  } catch {
    return undefined;
  }
}

/**
 * Keeps an approval that was just signed: the statement first, then its signature. An approval
 * is only read when both are there, so one that is half kept is never taken for a whole one.
 * Returns false when it could not be kept.
 */
export function keepApproval(root: string, commit: string, branch: string, statementFile: string, signatureFile: string): boolean {
  const folder = approvalsFolder(root);
  if (folder === undefined) return false;
  try {
    const commitFolder = join(folder, commit);
    mkdirSync(commitFolder, { recursive: true });
    const target = join(commitFolder, fileNameOf(branch));
    const statement = readFileSync(statementFile);
    const signature = readFileSync(signatureFile);
    writeWhole(target, statement);
    writeWhole(`${target}.sig`, signature);
    return true;
  } catch {
    return false;
  }
}
