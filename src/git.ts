import { spawnSync } from 'node:child_process';

export interface GitResult {
  /** True only when git started and exited with 0. */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one git command and returns what it printed.
 * It never throws: a git that is missing or fails comes back as `ok: false`.
 */
export function git(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: result.error.message };
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

/** The top folder of the repository that contains `cwd`, or undefined when there is none. */
export function repoRoot(cwd: string): string | undefined {
  const result = git(['rev-parse', '--show-toplevel'], cwd);
  if (!result.ok) return undefined;
  const root = result.stdout.trim();
  return root === '' ? undefined : root;
}

/** The full id of the commit that is checked out, or undefined when there is no commit yet. */
export function headCommit(root: string): string | undefined {
  const result = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root);
  if (!result.ok) return undefined;
  const sha = result.stdout.trim();
  return sha === '' ? undefined : sha;
}

/** The id of the file tree of the commit that is checked out. */
export function headTree(root: string): string | undefined {
  const result = git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], root);
  if (!result.ok) return undefined;
  const sha = result.stdout.trim();
  return sha === '' ? undefined : sha;
}

/** The name of the branch that is checked out, or undefined when no branch is (a detached HEAD). */
export function currentBranch(root: string): string | undefined {
  const result = git(['branch', '--show-current'], root);
  if (!result.ok) return undefined;
  const branch = result.stdout.trim();
  return branch === '' ? undefined : branch;
}

/**
 * Everything that differs from the last commit: changed, staged, deleted and new files.
 * Ignored files do not count. Returns undefined when git could not tell.
 */
export function uncommittedChanges(root: string): string[] | undefined {
  const result = git(['status', '--porcelain', '--untracked-files=all'], root);
  if (!result.ok) return undefined;
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

/**
 * The files git would commit: tracked files, plus new files that are not ignored.
 * Paths are relative to the repository root and use forward slashes.
 */
export function committableFiles(root: string): string[] | undefined {
  const result = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
  if (!result.ok) return undefined;
  return result.stdout.split('\0').filter((path) => path !== '');
}
