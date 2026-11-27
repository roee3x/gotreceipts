import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { recordsFolder } from '../record/store.ts';

/**
 * Where approvals are kept: gotreceipts/approvals inside the repository's .git folder, next to
 * the records. One approval per commit and branch. A newer one replaces the older one.
 *
 * An approval is two files: the statement, and its signature under the same name plus ".sig".
 */
function approvalsFolder(root: string): string | undefined {
  const records = recordsFolder(root);
  return records === undefined ? undefined : join(dirname(records), 'approvals');
}

/** A branch name as a file name. A branch may hold a slash, and a file name may not. */
function fileNameOf(branch: string): string {
  return `${encodeURIComponent(branch)}.json`;
}

/** How an approval's place is shown to the user: without the machine's folders in front of it. */
export function approvalLabel(commit: string, branch: string): string {
  return `.git/gotreceipts/approvals/${commit}/${fileNameOf(branch)}`;
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
 * Keeps an approval that was just signed. The two files are copied in under other names and
 * then renamed, the signature last, so a half-written approval is never read as a whole one.
 * Returns false when it could not be kept.
 */
export function keepApproval(root: string, commit: string, branch: string, statementFile: string, signatureFile: string): boolean {
  const folder = approvalsFolder(root);
  if (folder === undefined) return false;
  try {
    const commitFolder = join(folder, commit);
    mkdirSync(commitFolder, { recursive: true });
    const target = join(commitFolder, fileNameOf(branch));
    const temporary = `${target}.${process.pid}.tmp`;
    copyFileSync(statementFile, temporary);
    copyFileSync(signatureFile, `${temporary}.sig`);
    renameSync(temporary, target);
    renameSync(`${temporary}.sig`, `${target}.sig`);
    return true;
  } catch {
    return false;
  }
}
