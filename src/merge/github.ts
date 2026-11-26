import { spawnSync } from 'node:child_process';

/**
 * The few things this tool asks of GitHub, through GitHub's own command line tool, "gh".
 *
 * The tool never talks to GitHub directly and holds no token. It uses the sign-in "gh" already has.
 */

/** Names another program to run in place of "gh", as a JSON list. The tests point it at a stand-in. */
export const GH_COMMAND_VARIABLE = 'GOTRECEIPTS_GH_COMMAND';

export interface PullRequest {
  readonly number: number;
  /** OPEN, MERGED or CLOSED. */
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  /** The commit the pull request would merge. */
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly url: string;
}

export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

function ghCommand(): string[] {
  const override = process.env[GH_COMMAND_VARIABLE];
  if (override === undefined || override === '') return ['gh'];
  try {
    const parsed: unknown = JSON.parse(override);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === 'string')) {
      return parsed as string[];
    }
  } catch {
    // Reported below.
  }
  throw new Error(`${GH_COMMAND_VARIABLE} must be a JSON list of strings, for example ["gh"]`);
}

interface GhRun {
  readonly started: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function gh(args: readonly string[], cwd: string): GhRun {
  const [program, ...first] = ghCommand();
  const result = spawnSync(program ?? 'gh', [...first, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined) return { started: false, status: null, stdout: '', stderr: result.error.message };
  return { started: true, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function failure(run: GhRun): string {
  if (!run.started) return 'the GitHub command line tool "gh" could not be started. Is it installed?';
  const said = (run.stderr.trim() || run.stdout.trim()).split('\n')[0] ?? '';
  return said === '' ? `"gh" ended with exit code ${run.status}` : said;
}

function field<T>(source: unknown, name: string, type: 'string' | 'number' | 'boolean'): T | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[name];
  return typeof value === type ? (value as T) : undefined;
}

/** Asks GitHub about one pull request. */
export function viewPullRequest(cwd: string, number: number): Answer<PullRequest> {
  const fields = 'number,state,isDraft,headRefName,headRefOid,baseRefName,url';
  const run = gh(['pr', 'view', String(number), '--json', fields], cwd);
  if (!run.started || run.status !== 0) return { ok: false, error: failure(run) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { ok: false, error: '"gh" answered with something that is not JSON' };
  }
  const pullRequest = {
    number: field<number>(parsed, 'number', 'number'),
    state: field<string>(parsed, 'state', 'string'),
    isDraft: field<boolean>(parsed, 'isDraft', 'boolean'),
    headRefName: field<string>(parsed, 'headRefName', 'string'),
    headRefOid: field<string>(parsed, 'headRefOid', 'string'),
    baseRefName: field<string>(parsed, 'baseRefName', 'string'),
    url: field<string>(parsed, 'url', 'string'),
  };
  for (const [name, value] of Object.entries(pullRequest)) {
    if (value === undefined) return { ok: false, error: `the answer of "gh" has no usable "${name}"` };
  }
  if (!/^[0-9a-f]{40,64}$/.test(pullRequest.headRefOid ?? '')) {
    return { ok: false, error: 'the answer of "gh" does not name the head commit' };
  }
  return { ok: true, value: pullRequest as PullRequest };
}

export interface MergeRequest {
  readonly number: number;
  /** GitHub merges only if the pull request still points to this commit. */
  readonly commit: string;
  readonly method: MergeMethod;
  readonly subject?: string | undefined;
  readonly body?: string | undefined;
}

/** Asks GitHub to merge a pull request, pinned to one exact commit. Returns what "gh" printed. */
export function mergePullRequest(cwd: string, request: MergeRequest): Answer<string> {
  const args = ['pr', 'merge', String(request.number), `--${request.method}`, '--match-head-commit', request.commit];
  if (request.subject !== undefined) args.push('--subject', request.subject);
  if (request.body !== undefined) args.push('--body', request.body);
  const run = gh(args, cwd);
  if (!run.started || run.status !== 0) return { ok: false, error: failure(run) };
  return { ok: true, value: `${run.stdout}${run.stderr}`.trim() };
}

/** After a merge: the commit GitHub made on the base branch, or undefined when it does not say. */
export function mergeCommitOf(cwd: string, number: number): Answer<{ readonly state: string; readonly commit: string | undefined }> {
  const run = gh(['pr', 'view', String(number), '--json', 'state,mergeCommit'], cwd);
  if (!run.started || run.status !== 0) return { ok: false, error: failure(run) };
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    const state = field<string>(parsed, 'state', 'string');
    if (state === undefined) return { ok: false, error: 'the answer of "gh" has no usable "state"' };
    const mergeCommit = (parsed as Record<string, unknown>)['mergeCommit'];
    return { ok: true, value: { state, commit: field<string>(mergeCommit, 'oid', 'string') } };
  } catch {
    return { ok: false, error: '"gh" answered with something that is not JSON' };
  }
}

/** "owner/name" of the repository a pull request belongs to, read from its address. */
export function repositoryOf(pullRequestUrl: string): string | undefined {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(pullRequestUrl);
  return match?.[1];
}
