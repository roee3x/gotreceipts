// Outside-in tests for "gotreceipts audit": looking back at what entered a branch.
//
// A server is played by a bare repository. The work happens in one clone. The audit runs in
// another, fresh one, the way a CI machine would: it holds the history and nothing else.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { addRemote, gitIn, installPushHook, lastLine, runCli, tempRepo, testKey, writeIn, type RunResult, type TestKey } from './helpers/temp-repo.ts';

/**
 * develop needs a record. main also asks for an approval of every commit. The folder of the
 * checks is protected. One signer, "owner". Records and approvals travel.
 */
function policyFor(owner: TestKey): Record<string, unknown> {
  return {
    schema: 1,
    levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'develop', level: 'G0' },
      { branch: 'main', level: 'G0', needsApproval: true },
    ],
    protected: ['checks'],
    approval: { signers: [{ name: 'owner', key: owner.publicKey }] },
    travel: true,
  };
}

interface Scene {
  /** The clone the work is done in, on feature/thing. No hook is installed in it. */
  readonly work: string;
  readonly remote: string;
  readonly owner: TestKey;
  /** The commit main and develop point to on the remote at the start. */
  readonly base: string;
}

function rev(repo: string, name: string): string {
  return gitIn(repo, 'rev-parse', name).stdout.trim();
}

function scene(t: TestContext): Scene {
  const owner = testKey(t);
  const work = tempRepo(t, { policy: policyFor(owner) });
  const remote = addRemote(t, work);
  assert.equal(gitIn(work, 'push', '--quiet', 'origin', 'feature/thing:main', 'feature/thing:develop').status, 0);
  assert.equal(gitIn(work, 'fetch', '--quiet', 'origin').status, 0);
  return { work, remote, owner, base: rev(work, 'HEAD') };
}

/** Commits one changed file on the branch that is checked out, and returns the commit. */
function change(repo: string, path: string, content: string): string {
  writeIn(repo, path, content);
  assert.equal(gitIn(repo, 'add', '--all').status, 0);
  assert.equal(gitIn(repo, 'commit', '--quiet', '-m', `test: change ${path}`).status, 0);
  return rev(repo, 'HEAD');
}

/** Runs the gate on the commit that is checked out, and sends its record to the remote. */
function gateAndSend(repo: string): void {
  const gate = runCli(repo, ['gate', '--level', 'G0']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  const sent = runCli(repo, ['send']);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
}

/**
 * Merges a commit into a branch of the remote with plain git, the way a merge button would:
 * nothing of this tool is asked. `when` dates the merge commit, for a merge that happened earlier.
 */
function mergeInto(s: Scene, branch: string, commit: string, when?: Date): string {
  const date = when?.toISOString();
  assert.equal(gitIn(s.work, 'switch', '--quiet', '--detach', `origin/${branch}`).status, 0);
  const merged = spawnSync('git', ['-c', 'commit.gpgsign=false', 'merge', '--quiet', '--no-ff', '-m', 'test: a merge', commit], {
    cwd: s.work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  });
  assert.equal(merged.status, 0, merged.stderr);
  const made = rev(s.work, 'HEAD');
  assert.equal(gitIn(s.work, 'push', '--quiet', 'origin', `HEAD:${branch}`).status, 0);
  assert.equal(gitIn(s.work, 'switch', '--quiet', 'feature/thing').status, 0);
  assert.equal(gitIn(s.work, 'fetch', '--quiet', 'origin').status, 0);
  return made;
}

/** Runs the audit in a fresh clone of the remote, as a CI machine would. */
function audit(t: TestContext, s: Scene, args: string[], cloneArgs: string[] = []): RunResult {
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-ci-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const cloned = gitIn(tmpdir(), 'clone', '--quiet', '--branch', 'main', ...cloneArgs, s.remote, folder);
  assert.equal(cloned.status, 0, cloned.stderr);
  return runCli(folder, ['audit', ...args]);
}

// --- the central claim ---

test('a merge that went through the doors passes the audit', (t) => {
  const s = scene(t);
  const commit = change(s.work, 'data.txt', 'changed\n');
  gateAndSend(s.work);
  const merge = mergeInto(s, 'develop', commit);

  const result = audit(t, s, ['develop', '--since', s.base]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`gotreceipts audit: what entered "develop" on origin after commit ${s.base.slice(0, 7)}`), result.stdout);
  assert.ok(result.stdout.includes(`  ${merge.slice(0, 7)} merged commit ${commit.slice(0, 7)}: OK`), result.stdout);
  assert.ok(result.stdout.includes(`      policy: the one "develop" held before, at commit ${s.base.slice(0, 7)}`), result.stdout);
  assert.match(result.stdout, /\n {6}record: G0 record, passed 0\.0 hours before, as level G0 asked\n/);
  assert.doesNotMatch(result.stdout, /approval/);
  assert.equal(lastLine(result.stdout), 'VERDICT: PASS (the entry into "develop" had what the policy asked for)');
});

test('a merge that went around the tool is named, and a record that was made in time and never sent can still be sent', (t) => {
  const s = scene(t);
  const commit = change(s.work, 'data.txt', 'changed\n');
  assert.equal(runCli(s.work, ['gate', '--level', 'G0']).status, 0);
  // The record exists in the clone. Nobody sent it, and the merge did not go through the tool.
  const merge = mergeInto(s, 'develop', commit);

  const result = audit(t, s, ['develop', '--since', s.base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`  ${merge.slice(0, 7)} merged commit ${commit.slice(0, 7)}: NOT AS ASKED`), result.stdout);
  assert.match(result.stdout, /\n {6}record: NONE THAT COUNTS for level G0 \(there is no record for this commit\)\n/);
  assert.match(result.stdout, /VERDICT: FAIL \(the entry into "develop" had not what the policy asked for\)/);
  assert.equal(lastLine(result.stdout), 'gotreceipts send <commit>, in the clone that holds it. Then run the audit again.');

  assert.equal(runCli(s.work, ['send']).status, 0);
  assert.equal(audit(t, s, ['develop', '--since', s.base]).status, 0);
});

test('a record that is made after the commit was already in does not count', (t) => {
  const s = scene(t);
  const commit = change(s.work, 'data.txt', 'changed\n');
  // The merge happened an hour ago, with no record. The gate is run only now.
  mergeInto(s, 'develop', commit, new Date(Date.now() - 3_600_000));
  gateAndSend(s.work);

  const result = audit(t, s, ['develop', '--since', s.base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /record: NONE THAT COUNTS for level G0/);
  assert.match(result.stdout, /it was made after the commit had already entered the branch/);
});

// --- the approval ---

test('into a branch that asks for an approval, an entry without a signature is named, and one with it passes', (t) => {
  const s = scene(t);

  // The first commit has its record and no approval.
  const first = change(s.work, 'data.txt', 'first\n');
  gateAndSend(s.work);
  const firstMerge = mergeInto(s, 'main', first);

  // The second one is approved. With "travel", the approval goes to the remote as it is signed.
  const second = change(s.work, 'data.txt', 'second\n');
  assert.equal(runCli(s.work, ['gate', '--level', 'G0']).status, 0);
  const approved = runCli(s.work, ['approve', '--for', 'main', '--key', s.owner.file], {}, 'approve\n');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const secondMerge = mergeInto(s, 'main', second);

  const both = audit(t, s, ['main', '--since', s.base]);
  assert.equal(both.status, 1, both.stdout + both.stderr);
  assert.ok(both.stdout.includes(`  ${firstMerge.slice(0, 7)} merged commit ${first.slice(0, 7)}: NOT AS ASKED`), both.stdout);
  assert.match(
    both.stdout,
    /\n {6}approval: NONE THAT COUNTS \(there is no approval of this commit for "main"\)\. Needed because every commit that enters "main" needs one\n/,
  );
  assert.ok(both.stdout.includes(`  ${secondMerge.slice(0, 7)} merged commit ${second.slice(0, 7)}: OK`), both.stdout);
  assert.match(both.stdout, /\n {6}approval: by owner, 0\.0 hours before\. Needed because every commit that enters "main" needs one\n/);
  // In the order in which they entered.
  assert.ok(both.stdout.indexOf(firstMerge.slice(0, 7)) < both.stdout.indexOf(secondMerge.slice(0, 7)));
  assert.match(both.stdout, /VERDICT: FAIL \(1 of 2 entries into "main" had not what the policy asked for\)/);

  // The audit of the second push alone, as CI runs it after that push.
  const last = audit(t, s, ['main', '--since', firstMerge]);
  assert.equal(last.status, 0, last.stdout + last.stderr);
  assert.equal(lastLine(last.stdout), 'VERDICT: PASS (the entry into "main" had what the policy asked for)');
});

test('a change to a protected file that entered without a signature is named, file by file', (t) => {
  const s = scene(t);
  const commit = change(s.work, 'checks/pass.js', "console.log('a weaker check');\n");
  gateAndSend(s.work);
  mergeInto(s, 'develop', commit);

  const result = audit(t, s, ['develop', '--since', s.base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\n {6}1 protected file is not the same as on "develop" before: checks\/pass\.js\n/);
  assert.match(result.stdout, /\n {6}record: G0 record, passed 0\.0 hours before, as level G0 asked\n/);
  assert.match(
    result.stdout,
    /\n {6}approval: NONE THAT COUNTS \(there is no approval of this commit for "develop"\)\. Needed because it would change a protected file\n/,
  );
});

// --- pushes without a merge ---

test('a push through the hook leaves its record on the remote, and the audit finds it', (t) => {
  const s = scene(t);
  installPushHook(s.work);
  change(s.work, 'data.txt', 'one\n');
  const newest = change(s.work, 'data.txt', 'two\n');
  assert.equal(runCli(s.work, ['gate', '--level', 'G0']).status, 0);

  const pushed = gitIn(s.work, 'push', 'origin', 'feature/thing:develop');
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout + pushed.stderr, /develop: sent to the remote: 1 record/);

  const result = audit(t, s, ['develop', '--since', s.base]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`  ${newest.slice(0, 7)} pushed straight onto the branch (2 commits): OK`), result.stdout);
});

test('a push that skipped the hook is named', (t) => {
  const s = scene(t);
  const commit = change(s.work, 'data.txt', 'not gated\n');
  assert.equal(gitIn(s.work, 'push', '--quiet', 'origin', 'feature/thing:develop').status, 0);

  const result = audit(t, s, ['develop', '--since', s.base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`  ${commit.slice(0, 7)} pushed straight onto the branch (1 commit): NOT AS ASKED`), result.stdout);
});

// --- what landed is what was tested ---

test('a merge whose result is not the commit that was merged in is named', (t) => {
  const s = scene(t);
  // The commit that wants in is gated. Meanwhile the branch moves, and nobody gates the merged result.
  const commit = change(s.work, 'data.txt', 'changed\n');
  gateAndSend(s.work);
  assert.equal(gitIn(s.work, 'switch', '--quiet', '--detach', 'origin/develop').status, 0);
  const moved = change(s.work, 'other.txt', 'someone else got in first\n');
  assert.equal(runCli(s.work, ['gate', '--level', 'G0']).status, 0);
  assert.equal(runCli(s.work, ['send']).status, 0);
  assert.equal(gitIn(s.work, 'push', '--quiet', 'origin', 'HEAD:develop').status, 0);
  assert.equal(gitIn(s.work, 'switch', '--quiet', 'feature/thing').status, 0);
  assert.equal(gitIn(s.work, 'fetch', '--quiet', 'origin').status, 0);
  mergeInto(s, 'develop', commit);

  const result = audit(t, s, ['develop', '--since', moved]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(
    result.stdout.includes(`      result: NOT WHAT WAS TESTED. The merge holds files that are not the same as in commit ${commit.slice(0, 7)}`),
    result.stdout,
  );
  assert.match(result.stdout, /\n {6}record: G0 record, passed/);
});

// --- the edges ---

test('before the branch held a policy, nothing was asked', (t) => {
  const work = tempRepo(t, {});
  const remote = addRemote(t, work);
  assert.equal(gitIn(work, 'push', '--quiet', 'origin', 'feature/thing:main').status, 0);
  const base = rev(work, 'HEAD');
  const owner = testKey(t);
  change(work, 'gotreceipts.json', `${JSON.stringify(policyFor(owner), null, 2)}\n`);
  assert.equal(gitIn(work, 'push', '--quiet', 'origin', 'feature/thing:main').status, 0);

  const result = audit(t, { work, remote, owner, base }, ['main', '--since', base]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pushed straight onto the branch \(1 commit\): OK\n {6}"main" held no policy before this, so nothing was asked\n/);
});

test('without "--since" only the last entry is looked at, and an id of zeros means the same', (t) => {
  const s = scene(t);
  const first = change(s.work, 'data.txt', 'first\n');
  mergeInto(s, 'develop', first);
  const second = change(s.work, 'data.txt', 'second\n');
  gateAndSend(s.work);
  const secondMerge = mergeInto(s, 'develop', second);

  for (const args of [['develop'], ['develop', '--since', '0'.repeat(40)]]) {
    const result = audit(t, s, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^gotreceipts audit: the last entry into "develop" on origin\n/);
    assert.ok(result.stdout.includes(`  ${secondMerge.slice(0, 7)} merged commit ${second.slice(0, 7)}: OK`), result.stdout);
    assert.doesNotMatch(result.stdout, new RegExp(first.slice(0, 7)));
  }

  const nothing = audit(t, s, ['develop', '--since', secondMerge]);
  assert.equal(nothing.status, 0, nothing.stdout + nothing.stderr);
  assert.equal(lastLine(nothing.stdout), `VERDICT: PASS (nothing entered "develop" after commit ${secondMerge.slice(0, 7)})`);
});

test('the audit cannot run on part of the history, or from a commit that is not on the branch', (t) => {
  const s = scene(t);
  const commit = change(s.work, 'data.txt', 'changed\n');
  gateAndSend(s.work);
  mergeInto(s, 'develop', commit);

  // A clone with only the newest commit, as a CI checkout is unless it is told otherwise.
  const address = `file:///${s.remote.replace(/\\/g, '/').replace(/^\//, '')}`;
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-ci-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  assert.equal(gitIn(tmpdir(), 'clone', '--quiet', '--depth', '1', '--branch', 'develop', address, folder).status, 0);
  const shallow = runCli(folder, ['audit', 'develop']);
  assert.equal(shallow.status, 2, shallow.stdout + shallow.stderr);
  assert.match(shallow.stderr, /CANNOT RUN: this clone holds only part of the history, so what entered the branch cannot be read/);
  assert.match(shallow.stderr, /fetch-depth: 0/);

  // The commit that was merged in came from the side. It is not on the branch's own line.
  const side = audit(t, s, ['develop', '--since', commit]);
  assert.equal(side.status, 2, side.stdout + side.stderr);
  assert.match(side.stderr, new RegExp(`CANNOT RUN: commit ${commit.slice(0, 7)} is not on the branch's own line`));

  const noBranch = audit(t, s, []);
  assert.equal(noBranch.status, 2);
  assert.match(noBranch.stderr, /CANNOT RUN: name one branch, for example: gotreceipts audit main/);

  const unknownBranch = audit(t, s, ['no-such-branch']);
  assert.equal(unknownBranch.status, 2);
  assert.match(unknownBranch.stderr, /CANNOT RUN: the remote "origin" holds no branch "no-such-branch", or did not answer/);

  const unknownCommit = audit(t, s, ['develop', '--since', 'no-such-commit']);
  assert.equal(unknownCommit.status, 2);
  assert.match(unknownCommit.stderr, /CANNOT RUN: there is no commit "no-such-commit"/);

  const help = audit(t, s, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: gotreceipts audit <branch> \[options\]/);
});
