import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { git } from '../git.ts';

/**
 * Files that "gotreceipts install" writes into the working folder hold a path of this machine.
 * These two functions keep such a file out of every commit.
 */

/** True when the file is committed in this repository. `file` is relative to the top of it. */
export function isCommitted(root: string, file: string): boolean {
  return git(['ls-files', '--error-unmatch', '--', file], root).ok;
}

/**
 * Makes sure git will not offer the file for a commit. When no ignore rule covers it, a line
 * is added to the repository's own exclude file, which is local and never committed.
 * Returns true when a line was added.
 */
export function keepOutOfGit(root: string, file: string): boolean {
  if (git(['check-ignore', '--quiet', '--', file], root).ok) return false;
  const path = git(['rev-parse', '--git-path', 'info/exclude'], root);
  if (!path.ok || path.stdout.trim() === '') return false;
  const exclude = resolve(root, path.stdout.trim());
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `\n# Added by "gotreceipts install": this file holds a path of this machine.\n${file}\n`);
  return true;
}
