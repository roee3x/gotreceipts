// Outside-in tests for the rule that locks the policy:
// a commit is judged by the policy that is already on the branch it wants to enter.
//
// Each test plays the same move from a different side: a branch changes its own copy of the
// policy file to make its gate easier, and that must not help it.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { addRemote, gitIn, installPushHook, lastLine, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

const TIERS = [
  { branch: 'feature/*', level: 'G0' },
  { branch: 'main', level: 'G1' },
];
const BUILD = { name: 'build', run: 'node checks/pass.js' };

/** What is on main from the start. Entering main needs G1, and G1 holds a check that cannot pass. */
const STRICT = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [BUILD] },
    { name: 'G1', checks: [{ name: 'hard', run: 'node checks/fail.js' }] },
  ],
  tiers: TIERS,
};

/** The same policy, with the hard check swapped for one that always passes. */
const LOOSE = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [BUILD] },
    { name: 'G1', checks: [{ name: 'hard', run: 'node checks/pass.js' }] },
  ],
  tiers: TIERS,
};

/** The same policy, with no level for main at all. */
const UNGUARDED = { ...STRICT, tiers: [TIERS[0]] };

const NONE = '0'.repeat(40);

function head(repo: string): string {
  return gitIn(repo, 'rev-parse', 'HEAD').stdout.trim();
}

interface Scene {
  readonly repo: string;
  readonly remote: string;
  /** The commit main points to, on the remote and in what the clone remembers of it. */
  readonly base: string;
}

/** A repository on feature/thing, and a remote whose main holds `onMain` as its policy. */
function scene(t: TestContext, onMain: unknown = STRICT): Scene {
  const repo = tempRepo(t, { policy: onMain });
  const remote = addRemote(t, repo);
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', 'feature/thing:main').status, 0);
  assert.equal(gitIn(repo, 'fetch', '--quiet', 'origin').status, 0);
  return { repo, remote, base: head(repo) };
}

/** Commits a new policy file on the branch that is checked out, and returns the new commit. */
function commitPolicy(repo: string, policy: unknown): string {
  writeIn(repo, 'gotreceipts.json', `${JSON.stringify(policy, null, 2)}\n`);
  assert.equal(gitIn(repo, 'add', '--all').status, 0);
  const commit = gitIn(repo, 'commit', '--quiet', '-m', 'test: change the policy');
  assert.equal(commit.status, 0, commit.stderr);
  return head(repo);
}

/** Calls the push hook the way git does, for "push this commit to main, which is at `remoteCommit`". */
function pushToMain(repo: string, commit: string, remoteCommit: string) {
  const line = `refs/heads/feature/thing ${commit} refs/heads/main ${remoteCommit}\n`;
  return runCli(repo, ['hook', 'pre-push', 'origin', 'https://example.com/repo.git'], {}, line);
}

function policyIdIn(output: string): string {
  return /Policy id: (\S+)/.exec(output)?.[1] ?? '';
}

// --- the central claim ---

test('a branch cannot make its own gate easier: the gate runs the policy that is on the target branch', (t) => {
  const s = scene(t);
  commitPolicy(s.repo, LOOSE);

  const result = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`Policy: the one on origin/main, at commit ${s.base.slice(0, 7)}`));
  assert.match(result.stdout, /this commit changes the policy file\. It is judged by the policy that is already on origin\/main/);
  assert.match(result.stdout, /\[2\/2\] hard: FAIL \(exit code 3, /);
  assert.match(lastLine(result.stdout), /^VERDICT: FAIL \(level G1, /);
});

test('a record made under the policy of the commit itself opens no door', (t) => {
  const s = scene(t);
  const loosened = commitPolicy(s.repo, LOOSE);

  // With --level no branch is named, so the policy in the commit itself runs. It passes.
  const own = runCli(s.repo, ['gate', '--level', 'G1']);
  assert.equal(own.status, 0, own.stdout + own.stderr);
  assert.match(own.stdout, /Policy: the one in this commit/);

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /G1 record, passed 0\.0 hours ago: it was made under a different policy than the current one/);
  assert.equal(lastLine(verify.stdout), 'To make a record: gotreceipts gate --for main');

  const push = pushToMain(s.repo, loosened, s.base);
  assert.equal(push.status, 1, push.stdout + push.stderr);
  assert.match(push.stdout, /main: commit \w{7} needs level G1: REFUSED/);
  assert.match(push.stdout, /this commit changes the policy file\. It is judged by the policy that is already on "main" on the remote/);
  assert.match(push.stdout, /it was made under a different policy than the current one/);
});

test('a real git push of a commit that made its own gate easier is stopped', (t) => {
  const s = scene(t);
  installPushHook(s.repo);
  commitPolicy(s.repo, LOOSE);
  assert.equal(runCli(s.repo, ['gate', '--level', 'G1']).status, 0);

  const push = gitIn(s.repo, 'push', 'origin', 'feature/thing:main');
  assert.notEqual(push.status, 0, 'git must report the push as failed');
  assert.match(push.stdout + push.stderr, /VERDICT: REFUSED \(the pushed commit has no valid record\)/);
  assert.equal(gitIn(s.remote, 'rev-parse', 'refs/heads/main').stdout.trim(), s.base, 'main did not move');
});

test('taking the level off a branch in your own copy of the policy does not unguard it', (t) => {
  const s = scene(t);
  const unguarded = commitPolicy(s.repo, UNGUARDED);

  const push = pushToMain(s.repo, unguarded, s.base);
  assert.equal(push.status, 1, push.stdout + push.stderr);
  assert.match(push.stdout, /main: commit \w{7} needs level G1: REFUSED \(there is no record for this commit\)/);

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /level G1 on commit/);
});

// --- a change to the policy that is wanted ---

test('a change to the policy takes effect only after it passed the old policy and got in', (t) => {
  const first = { ...LOOSE, levels: [LOOSE.levels[0], { name: 'G1', checks: [{ name: 'old', run: 'node checks/pass.js' }] }] };
  const second = {
    ...LOOSE,
    levels: [
      LOOSE.levels[0],
      {
        name: 'G1',
        checks: [
          { name: 'old', run: 'node checks/pass.js' },
          { name: 'added', run: 'node checks/pass.js' },
        ],
      },
    ],
  };
  const s = scene(t, first);
  const change = commitPolicy(s.repo, second);

  // The commit that brings the new policy is itself gated under the old one.
  const before = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(before.status, 0, before.stdout + before.stderr);
  assert.match(before.stdout, /2 checks to run: build, old/);

  // That record is what the door asks for, and the door says that the policy is being changed.
  const push = pushToMain(s.repo, change, s.base);
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.match(push.stdout, /main: commit \w{7} needs level G1: PASS/);
  assert.match(push.stdout, /this commit changes the policy file/);

  // It gets in. From now on the new policy is the one on main.
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', 'feature/thing:main').status, 0);
  const stale = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(stale.status, 1, 'the record made under the old policy no longer counts for main');
  assert.match(stale.stdout, /it was made under a different policy than the current one/);

  const after = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /3 checks to run: build, old, added/);
  assert.doesNotMatch(after.stdout, /changes the policy file/);
});

// --- when the target has no policy to give ---

test('a branch that does not exist yet is judged by the policy in the commit itself, and the output says so', (t) => {
  const repo = tempRepo(t, { policy: LOOSE });

  const gate = runCli(repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /Policy: the one in this commit, because "main" does not exist yet/);

  const line = `refs/heads/feature/thing ${head(repo)} refs/heads/main ${NONE}\n`;
  const push = runCli(repo, ['hook', 'pre-push', 'origin', 'https://example.com/repo.git'], {}, line);
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.match(push.stdout, /policy: the one in this commit, because "main" does not exist yet/);
});

test('the first policy of a repository gets in under itself: the target branch holds none yet', (t) => {
  const repo = tempRepo(t);
  addRemote(t, repo);
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', 'feature/thing:main').status, 0);
  const base = head(repo);
  const withPolicy = commitPolicy(repo, LOOSE);

  const gate = runCli(repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /Policy: the one in this commit, because origin\/main holds no policy file yet/);

  const push = pushToMain(repo, withPolicy, base);
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.match(push.stdout, /policy: the one in this commit, because "main" on the remote holds no policy file yet/);
});

test('a policy on the target branch that is not valid stops everything, and the policy of the commit is not used instead', (t) => {
  const s = scene(t, { schema: 1, levels: [], tiers: [] });
  const fixed = commitPolicy(s.repo, LOOSE);

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 2);
  assert.match(gate.stderr, /CANNOT RUN: the policy on origin\/main is not valid: gotreceipts\.json: levels: must be a list with at least one level/);

  assert.equal(runCli(s.repo, ['verify', '--for', 'main']).status, 2);

  const push = pushToMain(s.repo, fixed, s.base);
  assert.equal(push.status, 2);
  assert.match(push.stderr, /CANNOT CHECK: main: the policy on "main" on the remote is not valid/);
  assert.match(push.stderr, /The push is blocked/);
});

// --- where the target branch is read from ---

test('what a remote has wins over a local branch of the same name', (t) => {
  const s = scene(t);
  const loosened = commitPolicy(s.repo, LOOSE);
  // A local branch "main" that points to the commit with the easier policy.
  assert.equal(gitIn(s.repo, 'branch', '--force', 'main', loosened).status, 0);

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 1, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /Policy: the one on origin\/main, at commit/);
});

test('a name that is not exactly a branch is not read as one', (t) => {
  const s = scene(t);
  commitPolicy(s.repo, LOOSE);
  // "main~0" would be the same commit as main, if git were allowed to read it as an expression.
  const result = runCli(s.repo, ['verify', '--for', 'main~0']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no tier for the branch "main~0"/);
});

test('the push hook does not go by what the clone remembers of the remote', (t) => {
  const s = scene(t);
  const loosened = commitPolicy(s.repo, LOOSE);
  // The clone's memory of main is moved to the commit with the easier policy.
  assert.equal(gitIn(s.repo, 'update-ref', 'refs/remotes/origin/main', loosened).status, 0);

  // The gate works without a network, from that memory. So it is fooled, and it passes.
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  // The door is not. Git itself tells the hook where main is on the remote.
  const push = pushToMain(s.repo, loosened, s.base);
  assert.equal(push.status, 1, push.stdout + push.stderr);
  assert.match(push.stdout, /it was made under a different policy than the current one/);
});

test('when the clone does not hold the commit the remote is at, the hook cannot check and blocks', (t) => {
  const s = scene(t);
  const unknown = 'c'.repeat(40);

  const push = pushToMain(s.repo, head(s.repo), unknown);
  assert.equal(push.status, 2);
  assert.match(push.stderr, /CANNOT CHECK: main: "main" on the remote is at commit ccccccc, which this clone does not hold/);
  assert.match(push.stderr, /Run "git fetch" and push again/);
});

// --- seeing which policy counts ---

test('"policy --for" shows the policy a commit must pass to enter a branch, not the file in the folder', (t) => {
  const s = scene(t);
  commitPolicy(s.repo, LOOSE);

  const onMain = runCli(s.repo, ['policy', '--for', 'main']);
  assert.equal(onMain.status, 0, onMain.stderr);
  assert.match(onMain.stdout, new RegExp(`The policy on origin/main, at commit ${s.base.slice(0, 7)}, is valid\\.`));
  assert.match(onMain.stdout, /A commit that wants to enter "main" is judged by it\./);
  assert.match(onMain.stdout, /G1 {2}2 checks: build, hard/);

  const inFolder = runCli(s.repo, ['policy']);
  assert.equal(inFolder.status, 0);
  assert.notEqual(policyIdIn(onMain.stdout), '');
  assert.notEqual(policyIdIn(onMain.stdout), policyIdIn(inFolder.stdout));

  const noBranch = runCli(s.repo, ['policy', '--for', 'nowhere']);
  assert.equal(noBranch.status, 2);
  assert.match(noBranch.stderr, /CANNOT RUN: this clone knows no branch "nowhere"/);

  assert.equal(runCli(s.repo, ['policy', '--for', 'main', '--file', 'gotreceipts.json']).status, 2);
});

// --- protected files ---

/** A policy that every commit passes, and that puts the folder of the checks under protection. */
const GUARDED = { ...LOOSE, protected: ['checks'] };

/** Commits one file on the branch that is checked out, and returns the new commit. */
function commitFile(repo: string, path: string, content: string): string {
  writeIn(repo, path, content);
  assert.equal(gitIn(repo, 'add', '--all').status, 0);
  const commit = gitIn(repo, 'commit', '--quiet', '-m', `test: change ${path}`);
  assert.equal(commit.status, 0, commit.stderr);
  return head(repo);
}

test('a commit that changes a protected file is named at every step: the gate, verify and the push', (t) => {
  const s = scene(t, GUARDED);
  const commit = commitFile(s.repo, 'checks/extra.js', 'process.exit(0);\n');

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /\n {8}1 protected file is not the same as on origin\/main: checks\/extra\.js\n/);

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /1 protected file is not the same as on origin\/main: checks\/extra\.js/);

  const push = pushToMain(s.repo, commit, s.base);
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.match(push.stdout, /1 protected file is not the same as on "main" on the remote: checks\/extra\.js/);
});

test('a commit that changes no protected file gets no such line', (t) => {
  const s = scene(t, GUARDED);
  const commit = commitFile(s.repo, 'data.txt', 'changed\n');

  for (const result of [runCli(s.repo, ['gate', '--for', 'main']), pushToMain(s.repo, commit, s.base)]) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /protected/);
  }
});

test('the policy file is protected even when the policy lists nothing, and even when only its layout changes', (t) => {
  const s = scene(t, LOOSE);
  // The same policy, written on one line. Its meaning, and so its id, is the same.
  commitFile(s.repo, 'gotreceipts.json', `${JSON.stringify(LOOSE)}\n`);

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.doesNotMatch(gate.stdout, /It is judged by the policy that is already on/);
  assert.match(gate.stdout, /1 protected file is not the same as on origin\/main: gotreceipts\.json/);
});

test('which files are protected is said by the target branch, so a commit cannot take a file off the list first', (t) => {
  const s = scene(t, GUARDED);
  commitPolicy(s.repo, LOOSE);
  commitFile(s.repo, 'checks/extra.js', 'process.exit(0);\n');
  gitIn(s.repo, 'rm', '--quiet', 'checks/fail.js');
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '-m', 'test: remove a check').status, 0);

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /3 protected files are not the same as on origin\/main: checks\/extra\.js, checks\/fail\.js, gotreceipts\.json/);
});

test('a long list of protected files is cut short, with a count of the rest', (t) => {
  const s = scene(t, GUARDED);
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) writeIn(s.repo, `checks/${name}.js`, 'process.exit(0);\n');
  assert.equal(gitIn(s.repo, 'add', '--all').status, 0);
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '-m', 'test: seven checks').status, 0);

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.match(
    gate.stdout,
    /7 protected files are not the same as on origin\/main: checks\/a\.js, checks\/b\.js, checks\/c\.js, checks\/d\.js, checks\/e\.js and 2 more\n/,
  );
});

test('a commit that would take a protected file back to an older state is seen, and the output says why it may be listed', (t) => {
  const s = scene(t, GUARDED);

  // Someone else changes a protected file on main, after this branch was cut.
  assert.equal(gitIn(s.repo, 'switch', '--quiet', '-c', 'feature/other').status, 0);
  const newer = commitFile(s.repo, 'checks/extra.js', 'process.exit(0);\n');
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', 'feature/other:main').status, 0);
  assert.equal(gitIn(s.repo, 'fetch', '--quiet', 'origin').status, 0);

  // This branch does not hold that change. If main pointed to it, the protected file would be gone again.
  assert.equal(gitIn(s.repo, 'switch', '--quiet', 'feature/thing').status, 0);
  const commit = commitFile(s.repo, 'data.txt', 'changed\n');

  const gate = runCli(s.repo, ['gate', '--for', 'main']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /1 protected file is not the same as on origin\/main: checks\/extra\.js/);
  assert.match(gate.stdout, /origin\/main holds commits this one does not, so a file may be listed because of a change made there/);

  const push = pushToMain(s.repo, commit, newer);
  assert.match(push.stdout, /1 protected file is not the same as on "main" on the remote: checks\/extra\.js/);
  assert.match(push.stdout, /"main" on the remote holds commits this one does not/);
});

test('"policy" lists the protected files, with the policy file first', (t) => {
  const s = scene(t, GUARDED);
  const result = runCli(s.repo, ['policy', '--for', 'main']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Protected files \(a change to one of these is a change to the gate itself\)\n {2}gotreceipts\.json {3}\(always, listed or not\)\n {2}checks\n/,
  );
});
