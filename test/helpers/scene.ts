// The scenes that several outside-in test files start from, built on temp-repo.ts:
// a clone with a server behind it, a policy with an owner, a change that is committed and
// gated, and the push hook called the way git calls it.
//
// A test file keeps what only it needs. What two files need lives here, once.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { addRemote, gitIn, head, runCli, tempRepo, writeIn, type RunResult, type TestKey } from './temp-repo.ts';

// --- a policy with an owner ---

/**
 * A policy with one signer, "owner", and one level whose one check passes. A feature branch
 * and develop need a record. main also asks for an approval of every commit.
 * `extra` adds settings, or replaces these.
 */
export function ownerPolicy(owner: TestKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'develop', level: 'G0' },
      { branch: 'main', level: 'G0', needsApproval: true },
    ],
    approval: { signers: [{ name: 'owner', key: owner.publicKey }] },
    ...extra,
  };
}

// --- a clone with a server behind it ---

export interface Served {
  /** The clone the work is done in, on feature/thing. */
  readonly repo: string;
  /** The bare repository that plays the server. The clone knows it as "origin". */
  readonly remote: string;
  /** The commit the branches of the server point to at the start. */
  readonly base: string;
}

/**
 * A repository on feature/thing with `policy` committed, and a remote whose `branches` hold
 * that same commit. The clone has fetched, so it knows where those branches are.
 */
export function served(t: TestContext, policy: unknown, branches: readonly string[] = ['main', 'develop']): Served {
  const repo = tempRepo(t, { policy });
  const remote = addRemote(t, repo);
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', ...branches.map((branch) => `feature/thing:${branch}`)).status, 0);
  assert.equal(gitIn(repo, 'fetch', '--quiet', 'origin').status, 0);
  return { repo, remote, base: head(repo) };
}

// --- a file, committed and gated ---

/** Commits one file, new or changed, on the branch that is checked out, and returns the new commit. */
export function commitFile(repo: string, path = 'data.txt', content = 'changed\n'): string {
  writeIn(repo, path, content);
  assert.equal(gitIn(repo, 'add', '--all').status, 0);
  const commit = gitIn(repo, 'commit', '--quiet', '-m', `test: change ${path}`);
  assert.equal(commit.status, 0, commit.stderr);
  return head(repo);
}

/** Runs the gate at level G0 on the commit that is checked out. It has to pass. */
export function gate(repo: string): void {
  const result = runCli(repo, ['gate', '--level', 'G0']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/** Commits one changed file, gates the commit, and returns it. */
export function gatedCommit(repo: string, path = 'data.txt', content = 'changed\n'): string {
  const commit = commitFile(repo, path, content);
  gate(repo);
  return commit;
}

// --- the push hook, called the way git calls it ---

/** What git writes in place of a commit for a branch that is not there. */
export const NO_COMMIT = '0'.repeat(40);

/**
 * The line git writes on the hook's input for "push this commit to that branch".
 * `remoteCommit` is where the branch is on the other side. Left out: the branch is new there.
 */
export function pushLine(commit: string, branch: string, remoteCommit = NO_COMMIT): string {
  return `refs/heads/feature/thing ${commit} refs/heads/${branch} ${remoteCommit}\n`;
}

/** Calls the push hook the way git does: the name and the address of the remote as its words, the lines on its input. */
export function pushHook(repo: string, input: string): RunResult {
  return runCli(repo, ['hook', 'pre-push', 'origin', 'https://example.com/repo.git'], {}, input);
}

/** What the push hook answers to "push this commit to that branch, which is at `remoteCommit` on the other side". */
export function tryPush(repo: string, commit: string, branch: string, remoteCommit = NO_COMMIT): RunResult {
  return pushHook(repo, pushLine(commit, branch, remoteCommit));
}
