// Outside-in tests for "gotreceipts merge".
//
// GitHub is played by a second repository and by a stand-in for the "gh" tool (helpers/fake-gh.ts).
// The stand-in writes down every request it gets, so the central claim can be checked directly:
// without a valid record, GitHub is never asked to merge.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { addRemote, gitIn, lastLine, runCli, tempRepo, testKey, writeIn, type TestKey } from './helpers/temp-repo.ts';

/** A feature branch needs G0. Entering main needs G1. The branch "notes" has no level. */
const POLICY = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] },
    { name: 'G1', checks: [{ name: 'extra', run: 'node checks/pass.js' }] },
  ],
  tiers: [
    { branch: 'feature/*', level: 'G0' },
    { branch: 'main', level: 'G1' },
  ],
};

const fakeGh = fileURLToPath(new URL('./helpers/fake-gh.ts', import.meta.url));

interface Scene {
  readonly repo: string;
  readonly remote: string;
  /** The commit the pull request would merge. */
  readonly head: string;
  /** The environment that makes the tool talk to the stand-in. */
  readonly env: Record<string, string>;
  /** Changes what the stand-in knows, as if something happened on GitHub. */
  change(update: (state: Record<string, any>) => void): void;
  /** Every request the stand-in got, as lists of arguments. */
  requests(): string[][];
  mergeRequests(): string[][];
}

function revision(folder: string, name: string): string {
  return gitIn(folder, 'rev-parse', name).stdout.trim();
}

/**
 * A repository with a feature branch one commit ahead of the target branch, both pushed,
 * and a pull request #7 from the one into the other.
 */
function scene(t: TestContext, base = 'main', withPolicy = true, policy: unknown = POLICY): Scene {
  const repo = tempRepo(t, withPolicy ? { policy } : {});
  const remote = addRemote(t, repo);
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', `feature/thing:${base}`).status, 0);

  writeIn(repo, 'data.txt', 'the change of the pull request\n');
  assert.equal(gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: the change').status, 0);
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', 'feature/thing').status, 0);

  const statePath = join(remote, 'fake-gh-state.json');
  const logPath = join(remote, 'fake-gh-log.txt');
  const state = {
    remote,
    log: logPath,
    pr: {
      number: 7,
      state: 'OPEN',
      isDraft: false,
      headRefName: 'feature/thing',
      baseRefName: base,
      url: 'https://github.com/example/demo/pull/7',
    },
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));

  const requests = (): string[][] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string[])
      : [];

  return {
    repo,
    remote,
    head: revision(repo, 'HEAD'),
    env: { GOTRECEIPTS_GH_COMMAND: JSON.stringify([process.execPath, fakeGh]), FAKE_GH_STATE: statePath },
    change(update) {
      const current = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, any>;
      update(current);
      writeFileSync(statePath, JSON.stringify(current, null, 2));
    },
    requests,
    mergeRequests: () => requests().filter((request) => request[1] === 'merge'),
  };
}

/** Adds a commit to a branch on the remote that the feature branch does not contain. */
function moveBase(s: Scene, file: string, content: string, base = 'main'): string {
  assert.equal(gitIn(s.repo, 'switch', '--quiet', '--detach', `origin/${base}`).status, 0);
  writeIn(s.repo, file, content);
  assert.equal(gitIn(s.repo, 'add', '--all').status, 0);
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '-m', 'test: someone else got in first').status, 0);
  const commit = revision(s.repo, 'HEAD');
  assert.equal(gitIn(s.repo, 'switch', '--quiet', 'feature/thing').status, 0);
  return commit;
}

// --- the central claim ---

test('without a record, the merge is refused and GitHub is never asked to merge', (t) => {
  const s = scene(t);
  const before = revision(s.remote, 'refs/heads/main');

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /gotreceipts merge: pull request #7, feature\/thing into main/);
  assert.match(result.stdout, new RegExp(`commit ${s.head.slice(0, 7)} needs level G1`));
  assert.match(result.stdout, /VERDICT: REFUSED \(there is no record for this commit\)\. Nothing was merged\./);
  assert.equal(lastLine(result.stdout), 'To make a record: gotreceipts gate --for main');

  assert.deepEqual(s.mergeRequests(), []);
  assert.equal(revision(s.remote, 'refs/heads/main'), before);
});

test('a record of a lower level is not enough', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate']).status, 0, 'G0, the level of the feature branch');

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /G0 record, passed 0\.0 hours ago: its level is below G1/);
  assert.deepEqual(s.mergeRequests(), []);
});

test('with a valid record, the pull request is merged, pinned to the tested commit', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /G1 record, passed 0\.0 hours ago, under the current policy/);
  assert.match(result.stdout, new RegExp(`the merged result holds exactly the files of commit ${s.head.slice(0, 7)}`));
  assert.match(result.stdout, /gh: Merged pull request #7/);
  assert.match(result.stdout, /merged as \w{7}, which holds exactly the tested files/);
  assert.equal(lastLine(result.stdout), `VERDICT: MERGED (pull request #7, commit ${s.head.slice(0, 7)} into main)`);

  assert.deepEqual(s.mergeRequests(), [['pr', 'merge', '7', '--merge', '--match-head-commit', s.head]]);
  assert.equal(revision(s.remote, 'refs/heads/main^{tree}'), revision(s.repo, `${s.head}^{tree}`));
});

// --- the merged result ---

test('when the target branch holds changes the commit does not, the merge is refused before GitHub is asked', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  const moved = moveBase(s, 'other.txt', 'a change the feature branch has never seen\n');
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', `${moved}:main`).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /VERDICT: REFUSED \(the merged result would not be what was tested\)\. Nothing was merged\./);
  assert.match(result.stdout, /"main" holds changes that commit \w{7} does not contain/);
  assert.equal(lastLine(result.stdout), 'Merge main into the branch, run the gate on the new commit, and merge again.');
  assert.deepEqual(s.mergeRequests(), []);
});

test('the newest state of the target branch is asked from the remote, not taken from an old download', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  const moved = moveBase(s, 'other.txt', 'pushed without this clone noticing\n');
  // Pushed straight to the remote by commit id, then the local memory of it is wound back.
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', `${moved}:main`).status, 0);
  assert.equal(gitIn(s.repo, 'update-ref', 'refs/remotes/origin/main', `${s.head}~1`).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the merged result would not be what was tested/);
});

test('a commit that conflicts with the target branch is refused', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  const moved = moveBase(s, 'data.txt', 'a different change to the same line\n');
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', `${moved}:main`).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERDICT: REFUSED \(commit \w{7} conflicts with "main"\)\. Nothing was merged\./);
  assert.deepEqual(s.mergeRequests(), []);
});

test('when the target branch moves during the merge itself, the result is reported as not tested', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  // The commit exists on the remote, but main only jumps to it at the moment of the merge.
  const moved = moveBase(s, 'other.txt', 'someone else, at the same moment\n');
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', `${moved}:refs/heads/waiting`).status, 0);
  s.change((state) => {
    state.moveBaseTo = moved;
  });

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /VERDICT: MERGED, BUT NOT AS TESTED \(commit \w{7} on main holds files that no gate has seen\)/);
  assert.match(result.stdout, /"main" moved in the moment between the check and the merge\./);
  assert.match(lastLine(result.stdout), /^Run the gate on it now: gotreceipts gate --for main {3}\(with commit \w{7} checked out\)$/);
  assert.equal(s.mergeRequests().length, 1);
});

// --- the pull request itself ---

test('a pull request that is not open, or is a draft, is refused', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  for (const state of ['MERGED', 'CLOSED']) {
    s.change((current) => {
      current.pr.state = state;
    });
    const result = runCli(s.repo, ['merge', '7'], s.env);
    assert.equal(result.status, 1, state);
    assert.match(result.stdout, new RegExp(`pull request #7 is not open: GitHub shows it as ${state.toLowerCase()}`));
  }

  s.change((current) => {
    current.pr.state = 'OPEN';
    current.pr.isDraft = true;
  });
  const draft = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(draft.status, 1);
  assert.match(draft.stdout, /VERDICT: REFUSED \(pull request #7 is a draft\)/);
  assert.deepEqual(s.mergeRequests(), []);
});

test('the record must be of the commit GitHub has, not of the commit that is checked out', (t) => {
  const s = scene(t);
  // A newer commit is gated locally, and never pushed. The pull request still points to the older one.
  writeIn(s.repo, 'data.txt', 'a newer local change\n');
  gitIn(s.repo, 'commit', '--quiet', '--all', '-m', 'test: not pushed');
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`commit ${s.head.slice(0, 7)} needs level G1`));
  assert.equal(lastLine(result.stdout), `To make a record: gotreceipts gate --for main   (with commit ${s.head.slice(0, 7)} checked out)`);
  assert.deepEqual(s.mergeRequests(), []);
});

test('a branch with no level is merged without a record, and the output says so', (t) => {
  const s = scene(t, 'notes');

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the policy sets no level for "notes", so no record is needed/);
  assert.equal(lastLine(result.stdout), `VERDICT: MERGED (pull request #7, commit ${s.head.slice(0, 7)} into notes, a branch with no level)`);
  assert.deepEqual(s.mergeRequests(), [['pr', 'merge', '7', '--merge', '--match-head-commit', s.head]]);
});

test('when GitHub refuses the merge, the answer says so and gives its reason', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  s.change((state) => {
    state.refuseMerge = 'GraphQL: Required status check "CI passed" is expected. (mergePullRequest)';
  });

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERDICT: REFUSED \(GitHub did not merge the pull request\)\. Nothing was merged\./);
  assert.equal(lastLine(result.stdout), 'GitHub said: GraphQL: Required status check "CI passed" is expected. (mergePullRequest)');
});

// --- options, and things that cannot run ---

test('the merge method and the commit message are handed on to GitHub', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  const result = runCli(s.repo, ['merge', '#7', '--method', 'squash', '--subject', 'one line', '--body', 'more words'], s.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(s.mergeRequests(), [
    ['pr', 'merge', '7', '--squash', '--match-head-commit', s.head, '--subject', 'one line', '--body', 'more words'],
  ]);
});

test('a missing or odd pull request number, or an unknown method, cannot run', (t) => {
  const s = scene(t);
  for (const args of [['merge'], ['merge', 'seven'], ['merge', '0'], ['merge', '7', '8'], ['merge', '7', '--method', 'fast']]) {
    const result = runCli(s.repo, args, s.env);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /CANNOT RUN/, args.join(' '));
  }
  assert.equal(runCli(s.repo, ['merge', '--help']).status, 0);
  assert.deepEqual(s.requests(), [], 'GitHub was not asked anything');
});

test('when the GitHub tool is missing or fails, the command cannot run', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  const missing = runCli(s.repo, ['merge', '7'], { GOTRECEIPTS_GH_COMMAND: JSON.stringify([join(s.remote, 'no-such-program')]) });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /CANNOT RUN: GitHub could not be asked about pull request #7: the GitHub command line tool "gh" could not be started/);

  s.change((state) => {
    state.failView = 'HTTP 401: Bad credentials';
  });
  const failing = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(failing.status, 2);
  assert.match(failing.stderr, /GitHub could not be asked about pull request #7: HTTP 401: Bad credentials/);
  assert.deepEqual(s.mergeRequests(), []);
});

test('without a committed policy the command cannot run', (t) => {
  const s = scene(t, 'main', false);
  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gotreceipts merge: CANNOT RUN: commit \w{7} holds no policy file \(gotreceipts\.json\)/);
  assert.deepEqual(s.mergeRequests(), []);
});

// --- which policy counts ---

test('a pull request that takes the level off its target branch is still judged by the policy on that branch', (t) => {
  const s = scene(t);
  // The pull request's own copy of the policy no longer sets a level for main.
  writeIn(s.repo, 'gotreceipts.json', `${JSON.stringify({ ...POLICY, tiers: [POLICY.tiers[0]] }, null, 2)}\n`);
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '--all', '-m', 'test: main needs nothing').status, 0);
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', 'feature/thing').status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /policy: the one on origin\/main, at commit \w{7}/);
  assert.match(result.stdout, /this commit changes the policy file\. It is judged by the policy that is already on origin\/main/);
  assert.match(result.stdout, /1 protected file is not the same as on origin\/main: gotreceipts\.json/);
  assert.match(result.stdout, /commit \w{7} needs level G1/);
  assert.match(result.stdout, /VERDICT: REFUSED \(there is no record for this commit\)\. Nothing was merged\./);
  assert.deepEqual(s.mergeRequests(), []);
});

test('a record made under the easier policy of the pull request itself does not merge it', (t) => {
  const s = scene(t);
  // The pull request swaps the check of G1 for another one, and gates itself under that.
  const easier = structuredClone(POLICY);
  easier.levels[1]!.checks[0]!.name = 'easier';
  writeIn(s.repo, 'gotreceipts.json', `${JSON.stringify(easier, null, 2)}\n`);
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '--all', '-m', 'test: an easier G1').status, 0);
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', 'feature/thing').status, 0);
  assert.equal(runCli(s.repo, ['gate', '--level', 'G1']).status, 0, 'its own policy passes');

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /G1 record, passed 0\.0 hours ago: it was made under a different policy than the current one/);
  assert.equal(lastLine(result.stdout), 'To make a record: gotreceipts gate --for main');
  assert.deepEqual(s.mergeRequests(), []);
});

test('the policy is the one the remote has now, not the one this clone remembers', (t) => {
  const s = scene(t);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  // A stricter policy reaches main on the remote, and the local memory of main is wound back.
  const stricter = structuredClone(POLICY);
  stricter.levels[1]!.checks.push({ name: 'added-later', run: 'node checks/pass.js' });
  const moved = moveBase(s, 'gotreceipts.json', `${JSON.stringify(stricter, null, 2)}\n`);
  assert.equal(gitIn(s.repo, 'push', '--quiet', 'origin', `${moved}:main`).status, 0);
  assert.equal(gitIn(s.repo, 'update-ref', 'refs/remotes/origin/main', `${s.head}~1`).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`policy: the one on origin/main, at commit ${moved.slice(0, 7)}`));
  assert.match(result.stdout, /it was made under a different policy than the current one/);
  assert.deepEqual(s.mergeRequests(), []);
});

// --- the approval ---

/** The same policy, with one signer, and with main asking for an approval of every commit. */
function approvalPolicy(owner: TestKey): unknown {
  return {
    ...POLICY,
    tiers: [POLICY.tiers[0], { branch: 'main', level: 'G1', needsApproval: true }],
    approval: { signers: [{ name: 'owner', key: owner.publicKey }] },
  };
}

test('into a branch that asks for an approval, nothing is merged without one, and GitHub is never asked', (t) => {
  const owner = testKey(t);
  const s = scene(t, 'main', true, approvalPolicy(owner));
  const short = s.head.slice(0, 7);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /G1 record, passed 0\.0 hours ago, under the current policy/);
  assert.match(result.stdout, /approval: needed, because every commit that enters "main" needs one/);
  assert.match(result.stdout, /there is no approval of this commit for "main"/);
  assert.ok(
    result.stdout.includes(`VERDICT: REFUSED (commit ${short} has its record, and no valid approval for "main"). Nothing was merged.`),
    result.stdout,
  );
  assert.equal(lastLine(result.stdout), `  gotreceipts approve ${short} --for main`);
  assert.deepEqual(s.mergeRequests(), []);
});

test('the owner approves the pull request by its number, and then it is merged', (t) => {
  const owner = testKey(t);
  const s = scene(t, 'main', true, approvalPolicy(owner));
  const short = s.head.slice(0, 7);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);

  const approved = runCli(s.repo, ['approve', '--pr', '7', '--key', owner.file], s.env, 'approve\n');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.ok(approved.stdout.includes(`gotreceipts approve: commit ${short} into "main"`), approved.stdout);
  assert.match(approved.stdout, /policy: the one on origin\/main, at commit \w{7}/);
  assert.equal(lastLine(approved.stdout), `VERDICT: APPROVED (commit ${short} into "main", by owner)`);

  const result = runCli(s.repo, ['merge', '7'], s.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /approved by owner, 0\.0 hours ago/);
  assert.equal(lastLine(result.stdout), `VERDICT: MERGED (pull request #7, commit ${short} into main)`);
  assert.deepEqual(s.mergeRequests(), [['pr', 'merge', '7', '--merge', '--match-head-commit', s.head]]);
});

test('"approve --pr" cannot run for a pull request that is closed, or that GitHub does not know', (t) => {
  const owner = testKey(t);
  const s = scene(t, 'main', true, approvalPolicy(owner));

  s.change((state) => {
    state['pr'].state = 'MERGED';
  });
  const closed = runCli(s.repo, ['approve', '--pr', '7', '--key', owner.file], s.env, 'approve\n');
  assert.equal(closed.status, 2);
  assert.match(closed.stderr, /CANNOT RUN: pull request #7 is not open: GitHub shows it as merged/);

  s.change((state) => {
    state['failView'] = 'no pull requests found';
  });
  const unknown = runCli(s.repo, ['approve', '--pr', '7', '--key', owner.file], s.env, 'approve\n');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /CANNOT RUN: GitHub could not be asked about pull request #7/);
});
