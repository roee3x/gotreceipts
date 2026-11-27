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

/** The full id of the commit a name points to (a branch, a tag, a short id), or undefined when there is none. */
export function resolveCommit(root: string, name: string): string | undefined {
  // A name that starts with "-" would be read by git as an option, so it is refused here.
  if (name.startsWith('-')) return undefined;
  const result = git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], root);
  if (!result.ok) return undefined;
  const sha = result.stdout.trim();
  return sha === '' ? undefined : sha;
}

/**
 * The commit a ref points to, by its full name, for example "refs/heads/main".
 * Only an exact name counts. A name is never read as an expression such as "main~1".
 */
export function refCommit(root: string, fullName: string): string | undefined {
  if (!fullName.startsWith('refs/')) return undefined;
  const result = git(['show-ref', '--verify', '--hash', fullName], root);
  if (!result.ok) return undefined;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(sha) && hasCommit(root, sha) ? sha : undefined;
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

/** True when the repository holds this commit. */
export function hasCommit(root: string, sha: string): boolean {
  return git(['cat-file', '-e', `${sha}^{commit}`], root).ok;
}

/** The id of the file tree of a commit. Two commits with the same tree hold exactly the same files. */
export function treeOf(root: string, commit: string): string | undefined {
  const result = git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], root);
  if (!result.ok) return undefined;
  const tree = result.stdout.trim();
  return tree === '' ? undefined : tree;
}

/**
 * The files that are not the same in two commits: changed, added or removed.
 * Paths are counted from the top of the repository and use forward slashes.
 * A renamed file shows up under both names. Returns undefined when git could not compare.
 */
export function differingFiles(root: string, from: string, to: string): string[] | undefined {
  const result = git(['diff', '--name-only', '--no-renames', '-z', from, to, '--'], root);
  if (!result.ok) return undefined;
  return result.stdout.split('\0').filter((path) => path !== '');
}

/** True when `older` is `newer` itself or part of its history. */
export function isAncestor(root: string, older: string, newer: string): boolean {
  return git(['merge-base', '--is-ancestor', older, newer], root).ok;
}

export type MergedTree =
  | { readonly kind: 'clean'; readonly tree: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Works out the file tree that merging `head` into `base` would produce.
 * Nothing is checked out and no branch moves: git computes the result in its own storage.
 */
export function mergedTree(root: string, base: string, head: string): MergedTree {
  const result = git(['merge-tree', '--write-tree', '--no-messages', base, head], root);
  const firstLine = result.stdout.split('\n')[0]?.trim() ?? '';
  const isTree = /^[0-9a-f]{40,64}$/.test(firstLine);
  if (result.ok && isTree) return { kind: 'clean', tree: firstLine };
  // With a conflict, git still prints a tree and then names the files that conflict.
  if (!result.ok && isTree) return { kind: 'conflict' };
  return { kind: 'error', message: result.stderr.trim().split('\n')[0] ?? 'git merge-tree failed' };
}

/** The names of the remotes of this repository, with the address of each. */
export function remotes(root: string): { readonly name: string; readonly url: string }[] {
  const result = git(['remote'], root);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => ({ name, url: git(['remote', 'get-url', name], root).stdout.trim() }));
}

/** The commit a branch points to on the remote right now, asked from the remote itself. */
export function remoteBranchTip(root: string, remote: string, branch: string): string | undefined {
  const result = git(['ls-remote', remote, `refs/heads/${branch}`], root);
  if (!result.ok) return undefined;
  const sha = result.stdout.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

/** Downloads what a ref of the remote points to. No local branch moves. */
export function fetchRef(root: string, remote: string, ref: string): boolean {
  return git(['fetch', '--quiet', '--no-tags', remote, ref], root).ok;
}
