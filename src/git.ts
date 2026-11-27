import { spawnSync } from 'node:child_process';

/**
 * Everything this tool asks of git, through git's own command line.
 *
 * No function here throws. A git that is missing, or that fails, comes back as "not ok" or as
 * undefined, and the caller says what that means for its question.
 */

/** The most git may print in one call. The list of files of a large commit is long. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface GitResult {
  /** True only when git started and exited with 0. */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitBytes {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * Runs one git command with bytes in and bytes out.
 * A record is text, but a signature is checked byte for byte, so its file must not pass through a text.
 */
export function gitBytes(args: readonly string[], cwd: string, input?: Buffer, env?: NodeJS.ProcessEnv): GitBytes {
  const result = spawnSync('git', args, { cwd, input, env, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
  if (result.error !== undefined) return { ok: false, stdout: Buffer.alloc(0), stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.toString('utf8') };
}

/** Runs one git command and returns what it printed, as text. */
export function git(args: readonly string[], cwd: string): GitResult {
  const result = gitBytes(args, cwd);
  return { ok: result.ok, stdout: result.stdout.toString('utf8'), stderr: result.stderr };
}

// --- names and ids ---

const FULL_ID = /^[0-9a-f]{40,64}$/;

/** True for a full id as git writes it, of a commit or of a file tree: 40 digits, or 64 in a repository that uses SHA-256. */
export function isFullId(text: string): boolean {
  return FULL_ID.test(text);
}

/** True for what git writes in place of a commit id when there is none: a branch that is new, or one that is being deleted. */
export function isNoCommit(id: string): boolean {
  return /^0+$/.test(id);
}

/** A commit id as it is shown: its first seven digits. */
export function shortId(commit: string): string {
  return commit.slice(0, 7);
}

/** What the full name of every branch starts with. A tag, or any other kind of ref, starts differently. */
export const BRANCH_PREFIX = 'refs/heads/';

/** The full name of a branch, as git keeps it. */
export function branchRef(branch: string): string {
  return `${BRANCH_PREFIX}${branch}`;
}

/** The id an expression stands for, such as "HEAD^{commit}", or undefined when it stands for nothing. */
function idOf(root: string, expression: string): string | undefined {
  const result = git(['rev-parse', '--verify', '--quiet', expression], root);
  if (!result.ok) return undefined;
  const id = result.stdout.trim();
  return id === '' ? undefined : id;
}

// --- the repository as it is here ---

/** The top folder of the repository that contains `cwd`, or undefined when there is none. */
export function repoRoot(cwd: string): string | undefined {
  const result = git(['rev-parse', '--show-toplevel'], cwd);
  if (!result.ok) return undefined;
  const root = result.stdout.trim();
  return root === '' ? undefined : root;
}

/** The full id of the commit that is checked out, or undefined when there is no commit yet. */
export function headCommit(root: string): string | undefined {
  return idOf(root, 'HEAD^{commit}');
}

/** The full id of the commit a name points to (a branch, a tag, a short id), or undefined when there is none. */
export function resolveCommit(root: string, name: string): string | undefined {
  // A name that starts with "-" would be read by git as an option, so it is refused here.
  if (name.startsWith('-')) return undefined;
  return idOf(root, `${name}^{commit}`);
}

/** The id of the file tree of a commit. Two commits with the same tree hold exactly the same files. */
export function treeOf(root: string, commit: string): string | undefined {
  return idOf(root, `${commit}^{tree}`);
}

/** True when the repository holds this commit. */
export function hasCommit(root: string, commit: string): boolean {
  return git(['cat-file', '-e', `${commit}^{commit}`], root).ok;
}

/**
 * The commit a ref points to, by its full name, for example "refs/heads/main".
 * Only an exact name counts. A name is never read as an expression such as "main~1".
 */
export function refCommit(root: string, fullName: string): string | undefined {
  if (!fullName.startsWith('refs/')) return undefined;
  const result = git(['show-ref', '--verify', '--hash', fullName], root);
  if (!result.ok) return undefined;
  const commit = result.stdout.trim();
  return isFullId(commit) && hasCommit(root, commit) ? commit : undefined;
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

// --- two commits compared ---

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
  const isTree = isFullId(firstLine);
  if (result.ok && isTree) return { kind: 'clean', tree: firstLine };
  // With a conflict, git still prints a tree and then names the files that conflict.
  if (!result.ok && isTree) return { kind: 'conflict' };
  return { kind: 'error', message: result.stderr.trim().split('\n')[0] ?? 'git merge-tree failed' };
}

// --- the remote ---

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

/** The commit a ref points to on the remote right now, asked from the remote itself. Undefined when it holds no such ref. */
export function remoteRefCommit(root: string, remote: string, ref: string): { readonly ok: true; readonly commit: string | undefined } | { readonly ok: false; readonly stderr: string } {
  const result = git(['ls-remote', remote, ref], root);
  if (!result.ok) return { ok: false, stderr: result.stderr };
  const commit = result.stdout.trim().split(/\s+/)[0] ?? '';
  return { ok: true, commit: isFullId(commit) ? commit : undefined };
}

/** Downloads what a ref of the remote points to. No local branch moves. */
export function fetchRef(root: string, remote: string, ref: string): boolean {
  return git(['fetch', '--quiet', '--no-tags', remote, ref], root).ok;
}

/** True when the clone holds the commit. When it does not yet, the commit is first downloaded from a ref of the remote. */
export function obtainCommit(root: string, remote: string, ref: string, commit: string): boolean {
  return hasCommit(root, commit) || (fetchRef(root, remote, ref) && hasCommit(root, commit));
}

export type RemoteBranch =
  | { readonly kind: 'found'; readonly commit: string }
  /** The remote holds no such branch, or did not answer. */
  | { readonly kind: 'unknown' }
  /** The remote named the commit, and it could not be downloaded. */
  | { readonly kind: 'not-downloaded' };

/**
 * Where a branch is on the remote right now, with that commit downloaded.
 *
 * It is asked from the remote itself, and not taken from what this clone remembers of it. A
 * clone that has not fetched for a while remembers an older state, and the policy on a branch
 * is read from the commit this gives.
 */
export function remoteBranch(root: string, remote: string, branch: string): RemoteBranch {
  const asked = remoteRefCommit(root, remote, branchRef(branch));
  if (!asked.ok || asked.commit === undefined) return { kind: 'unknown' };
  if (!obtainCommit(root, remote, branchRef(branch), asked.commit)) return { kind: 'not-downloaded' };
  return { kind: 'found', commit: asked.commit };
}
