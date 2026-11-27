// Outside-in tests for the pre-push hook.
//
// The first group calls the hook the way git does: a line of text on its input.
// The last group lets git itself call it, during a real push to a second repository.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NO_COMMIT, pushHook, pushLine } from './helpers/scene.ts';
import { addRemote, gitIn, head, installPushHook, lastLine, remoteHas, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

/** G0 holds one check that can be made to fail from outside. G1 adds a check that always passes. */
const POLICY = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [{ name: 'build', run: 'node checks/flaky.js' }] },
    { name: 'G1', checks: [{ name: 'extra', run: 'node checks/pass.js' }] },
  ],
  tiers: [
    { branch: 'feature/*', level: 'G0' },
    { branch: 'main', level: 'G1' },
  ],
};

const FAIL = { GOTRECEIPTS_TEST_FAIL: '1' };

test('a push of a commit with no record is refused, and the answer says how to make one', (t) => {
  const repo = tempRepo(t, { policy: POLICY });

  const result = pushHook(repo, pushLine(head(repo), 'feature/thing'));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /gotreceipts pre-push: 1 branch to check/);
  assert.match(
    result.stdout,
    new RegExp(`feature/thing: commit ${head(repo).slice(0, 7)} needs level G0: REFUSED \\(there is no record for this commit\\)`),
  );
  assert.match(result.stdout, /VERDICT: REFUSED \(the pushed commit has no valid record\)\. Nothing was pushed\./);
  assert.equal(lastLine(result.stdout), '  gotreceipts gate --for feature/thing');
});

test('after a passing gate, the push is allowed', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate']).status, 0);

  const result = pushHook(repo, pushLine(head(repo), 'feature/thing'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /needs level G0: PASS \(G0 record, passed 0\.0 hours ago\)/);
  // The branch is new on the other side, so there is no policy there to judge it by.
  assert.match(result.stdout, /policy: the one in this commit, because "feature\/thing" does not exist yet/);
  assert.equal(lastLine(result.stdout), 'VERDICT: PASS (1 pushed commit has a valid record)');
});

test('after a failing gate, the push is refused with the reason', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate'], FAIL).status, 1);

  const result = pushHook(repo, pushLine(head(repo), 'feature/thing'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /G0 record, failed 0\.0 hours ago: the check "build" failed: exit code 1/);
});

test('the level comes from the branch the commit would enter, not from the branch it is on', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate']).status, 0);

  // The G0 record is enough for a feature branch, and not enough to enter main.
  assert.equal(pushHook(repo, pushLine(head(repo), 'feature/other')).status, 0);
  const toMain = pushHook(repo, pushLine(head(repo), 'main'));
  assert.equal(toMain.status, 1);
  assert.match(toMain.stdout, /main: commit \w{7} needs level G1: REFUSED/);
  assert.match(toMain.stdout, /G0 record, passed 0\.0 hours ago: its level is below G1/);
  assert.equal(lastLine(toMain.stdout), '  gotreceipts gate --for main');
});

test('one commit without a record refuses the whole push', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const first = head(repo);
  assert.equal(runCli(repo, ['gate']).status, 0);
  writeIn(repo, 'data.txt', 'a second version\n');
  gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: second commit');
  const second = head(repo);

  const result = pushHook(repo, pushLine(first, 'feature/one') + pushLine(second, 'feature/two'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /2 branches to check/);
  assert.match(result.stdout, /feature\/one: commit \w{7} needs level G0: PASS/);
  assert.match(result.stdout, /feature\/two: commit \w{7} needs level G0: REFUSED/);
  assert.match(result.stdout, /VERDICT: REFUSED \(1 of 2 pushed commits has no valid record\)/);
});

test('when the commit to gate is not the one checked out, the advice says so', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const first = head(repo);
  writeIn(repo, 'data.txt', 'a second version\n');
  gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: second commit');

  const result = pushHook(repo, pushLine(first, 'feature/thing'));
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), `  gotreceipts gate --for feature/thing   (with commit ${first.slice(0, 7)} checked out)`);
});

test('a branch without a level, a tag and a deletion are let through, and each is named', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const commit = head(repo);

  const input =
    pushLine(commit, 'notes') +
    `refs/tags/v1 ${commit} refs/tags/v1 ${NO_COMMIT}\n` +
    `(delete) ${NO_COMMIT} refs/heads/main ${commit}\n`;
  const result = pushHook(repo, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 branches to check/);
  assert.match(result.stdout, /notes: not checked \(the policy sets no level for this branch\)/);
  assert.match(result.stdout, /refs\/tags\/v1: not checked \(not a branch\)/);
  assert.match(result.stdout, /main: not checked \(the branch is being deleted/);
  assert.equal(lastLine(result.stdout), 'VERDICT: PASS (nothing in this push needs a record)');
});

test('a push that changes nothing is allowed', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const result = pushHook(repo, '');
  assert.equal(result.status, 0);
  assert.equal(lastLine(result.stdout), 'VERDICT: PASS (nothing in this push needs a record)');
});

test('without a committed policy the hook cannot check, and that blocks the push', (t) => {
  const repo = tempRepo(t);
  // A policy file that is only in the folder does not count.
  writeIn(repo, 'gotreceipts.json', `${JSON.stringify(POLICY)}\n`);

  const result = pushHook(repo, pushLine(head(repo), 'feature/thing'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT CHECK: feature\/thing: commit \w{7} holds no policy file \(gotreceipts\.json\)\. Only a committed policy counts/);
  assert.match(result.stderr, /The push is blocked\. A check that could not run is never treated as a pass\./);
});

test('input the hook does not understand blocks the push', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const result = pushHook(repo, 'this is not what git writes\n');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT CHECK: git gave a line this hook does not understand/);
});

test('with "travel", a hook that was not told the remote says that nothing was sent, and still lets the push through', (t) => {
  const repo = tempRepo(t, { policy: { ...POLICY, travel: true } });
  assert.equal(runCli(repo, ['gate']).status, 0);
  const commit = head(repo);

  // Git gives the hook the remote as its first argument. A hook file that does not pass it on leaves it out.
  const result = runCli(repo, ['hook', 'pre-push'], {}, pushLine(commit, 'feature/thing'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\n {2}feature\/thing: NOT SENT to the remote: the hook was not told which remote the push goes to\n/);
  assert.ok(result.stdout.includes(`\n      Send it after the push: gotreceipts send ${commit.slice(0, 7)}\n`), result.stdout);
  assert.equal(lastLine(result.stdout), 'VERDICT: PASS (1 pushed commit has a valid record)');

  // Without "travel" nothing is sent anywhere, so there is nothing to say about it.
  const stays = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(stays, ['gate']).status, 0);
  const quiet = runCli(stays, ['hook', 'pre-push'], {}, pushLine(head(stays), 'feature/thing'));
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /NOT SENT|sent to the remote/);
});

test('an unknown hook name, or none, is "could not run"', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['hook']).status, 2);
  assert.equal(runCli(repo, ['hook', 'pre-lunch']).status, 2);
  assert.equal(runCli(repo, ['hook', '--help']).status, 0);
});

// --- git itself calls the hook ---

test('a real git push is stopped when the commit has no record', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  installPushHook(repo);

  const push = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.notEqual(push.status, 0, 'git must report the push as failed');
  assert.match(push.stdout + push.stderr, /VERDICT: REFUSED \(the pushed commit has no valid record\)/);
  assert.equal(remoteHas(remote, 'feature/thing'), false, 'nothing may have reached the other side');
});

test('a real git push goes through once the commit has its record', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  installPushHook(repo);
  assert.equal(runCli(repo, ['gate']).status, 0);

  const push = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.match(push.stdout + push.stderr, /VERDICT: PASS \(1 pushed commit has a valid record\)/);
  assert.equal(gitIn(remote, 'rev-parse', 'refs/heads/feature/thing').stdout.trim(), head(repo));
});

test('a real git push to a higher branch needs the higher level', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  installPushHook(repo);
  assert.equal(runCli(repo, ['gate']).status, 0);

  const tooLow = gitIn(repo, 'push', 'origin', 'feature/thing:main');
  assert.notEqual(tooLow.status, 0);
  assert.equal(remoteHas(remote, 'main'), false);

  assert.equal(runCli(repo, ['gate', '--for', 'main']).status, 0);
  const push = gitIn(repo, 'push', 'origin', 'feature/thing:main');
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.equal(remoteHas(remote, 'main'), true);
});
