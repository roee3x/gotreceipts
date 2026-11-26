import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from '../git.ts';
import { parsePolicy } from './parse.ts';
import { POLICY_FILE_NAME, type Policy } from './policy.ts';

export type LoadResult =
  | { readonly ok: true; readonly policy: Policy; readonly path: string; readonly root: string | undefined }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Finds and reads the policy.
 *
 * Without `file`, it is gotreceipts.json at the top of the repository that contains `cwd`.
 * A missing or broken policy is an error for the caller to report as "could not run".
 */
export function loadPolicy(cwd: string, file?: string): LoadResult {
  const root = repoRoot(cwd);

  let path: string;
  if (file !== undefined) {
    path = file;
  } else if (root !== undefined) {
    path = join(root, POLICY_FILE_NAME);
  } else {
    return { ok: false, errors: ['this folder is not inside a git repository'] };
  }

  if (!existsSync(path)) {
    return { ok: false, errors: [`no policy file at ${path}`] };
  }

  const parsed = parsePolicy(readFileSync(path, 'utf8'));
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors.map((error) => `${POLICY_FILE_NAME}: ${error}`) };
  }
  return { ok: true, policy: parsed.policy, path, root };
}
