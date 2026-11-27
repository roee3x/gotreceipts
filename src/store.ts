import { renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { git } from './git.ts';

/**
 * Where this tool keeps what it writes: the folder "gotreceipts" inside the repository's .git
 * folder. The records are in it, and the approvals.
 *
 * Inside .git, nothing of it can be committed by accident. It is the shared .git folder, so
 * every worktree of the repository sees the same files.
 */
export function storeFolder(root: string): string | undefined {
  const result = git(['rev-parse', '--git-common-dir'], root);
  if (!result.ok) return undefined;
  const commonDir = result.stdout.trim();
  if (commonDir === '') return undefined;
  return join(resolve(root, commonDir), 'gotreceipts');
}

/** How a place in the store is shown to the user: without the machine's folders in front of it. */
export function storeLabel(...parts: readonly string[]): string {
  return ['.git', 'gotreceipts', ...parts].join('/');
}

/**
 * Writes a file so that it is never read half-written: under another name first, then renamed.
 * The folder must be there. It throws when the file cannot be written.
 */
export function writeWhole(target: string, content: string | Buffer): void {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, target);
}
