// Outside-in tests for "gotreceipts verify".

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { gitIn, lastLine, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

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

function head(repo: string): string {
  return gitIn(repo, 'rev-parse', 'HEAD').stdout.trim();
}

function recordPath(repo: string, commit: string, level: string): string {
  return join(repo, '.git', 'gotreceipts', 'records', commit, `${level}.json`);
}

/** Rewrites a stored record, the way someone with access to the .git folder could. */
function editRecord(repo: string, level: string, change: (record: Record<string, any>) => void): void {
  const path = recordPath(repo, head(repo), level);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  change(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

test('a commit with no record is refused, and the answer says how to make one', (t) => {
  const repo = tempRepo(t, { policy: POLICY });

  const result = runCli(repo, ['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`commit ${head(repo).slice(0, 7)} needs level G0`));
  assert.match(result.stdout, /VERDICT: REFUSED \(there is no record for this commit\)/);
  assert.equal(lastLine(result.stdout), 'To make a record: gotreceipts gate');
});

test('after a passing gate, the commit is accepted', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate']).status, 0);

  const result = runCli(repo, ['verify']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /G0 record, passed 0\.0 hours ago, under the current policy/);
  assert.equal(lastLine(result.stdout), `VERDICT: PASS (commit ${head(repo).slice(0, 7)} satisfies level G0)`);
});

test('after a failing gate, the commit is refused with the reason', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate'], FAIL).status, 1);

  const result = runCli(repo, ['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /G0 record, failed 0\.0 hours ago: the check "build" failed: exit code 1/);
  assert.match(result.stdout, /VERDICT: REFUSED \(no record of this commit satisfies level G0\)/);
});

test('a record belongs to one commit: a new commit starts with none', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  const firstCommit = head(repo);

  writeIn(repo, 'data.txt', 'a second version\n');
  gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: second commit');

  assert.equal(runCli(repo, ['verify']).status, 1, 'the new commit has no record');
  assert.equal(runCli(repo, ['verify', firstCommit]).status, 0, 'the old commit still has its own');
  assert.equal(runCli(repo, ['verify', 'HEAD~1']).status, 0, 'a commit can be named in any way git understands');
});

test('the level a commit needs can come from the branch it wants to enter', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);

  // The G0 record is enough for the feature branch, and not enough to enter main.
  assert.equal(runCli(repo, ['verify']).status, 0);
  const forMain = runCli(repo, ['verify', '--for', 'main']);
  assert.equal(forMain.status, 1);
  assert.match(forMain.stdout, /G0 record, passed 0\.0 hours ago: its level is below G1/);
  // The advice names the branch again, so the gate reads the same policy this answer was given under.
  assert.equal(lastLine(forMain.stdout), 'To make a record: gotreceipts gate --for main');
  const byLevel = runCli(repo, ['verify', '--level', 'G1']);
  assert.equal(lastLine(byLevel.stdout), 'To make a record: gotreceipts gate --level G1');

  // A G1 record covers both.
  assert.equal(runCli(repo, ['gate', '--for', 'main']).status, 0);
  assert.equal(runCli(repo, ['verify', '--for', 'main']).status, 0);
  assert.equal(runCli(repo, ['verify', '--level', 'G0']).status, 0);
});

test('a record made before the policy of the target branch changed no longer counts', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  // The branch "main" exists, and holds the same policy.
  assert.equal(gitIn(repo, 'branch', 'main').status, 0);
  assert.equal(runCli(repo, ['gate', '--for', 'main']).status, 0);
  const before = runCli(repo, ['verify', '--for', 'main']);
  assert.equal(before.status, 0, before.stdout + before.stderr);
  assert.match(before.stdout, /policy: the one on main, at commit \w{7}/);

  // Someone else gets a stricter policy into main.
  const stricter = structuredClone(POLICY);
  stricter.levels[0]!.checks.push({ name: 'added-later', run: 'node checks/pass.js' });
  assert.equal(gitIn(repo, 'switch', '--quiet', 'main').status, 0);
  writeIn(repo, 'gotreceipts.json', `${JSON.stringify(stricter, null, 2)}\n`);
  assert.equal(gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: a stricter policy').status, 0);
  assert.equal(gitIn(repo, 'switch', '--quiet', 'feature/thing').status, 0);

  const result = runCli(repo, ['verify', '--for', 'main']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /it was made under a different policy than the current one/);
});

test('only a committed policy counts: the file in the folder is never read', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  assert.equal(runCli(repo, ['verify']).status, 0);

  // Edited in the folder and not committed: the answer does not change.
  const stricter = structuredClone(POLICY);
  stricter.levels[0]!.checks.push({ name: 'added-later', run: 'node checks/pass.js' });
  writeIn(repo, 'gotreceipts.json', `${JSON.stringify(stricter, null, 2)}\n`);
  assert.equal(runCli(repo, ['verify']).status, 0);

  // Deleted from the folder: the same.
  rmSync(join(repo, 'gotreceipts.json'));
  assert.equal(runCli(repo, ['verify']).status, 0);
});

test('a record that is too old no longer counts', (t) => {
  const repo = tempRepo(t, { policy: { ...POLICY, record: { maxAgeHours: 2 } } });
  runCli(repo, ['gate']);
  assert.equal(runCli(repo, ['verify']).status, 0);

  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  editRecord(repo, 'G0', (record) => {
    record['startedAt'] = threeHoursAgo;
    record['finishedAt'] = threeHoursAgo;
  });

  const result = runCli(repo, ['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /G0 record, passed 3\.0 hours ago: it is older than the 2 hours a record counts for/);
});

test('a pass does not survive a newer run that failed', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate', '--level', 'G1']).status, 0);
  assert.equal(runCli(repo, ['verify', '--level', 'G1']).status, 0);

  // The same commit, checked again, now fails its build.
  assert.equal(runCli(repo, ['gate', '--level', 'G0'], FAIL).status, 1);

  const result = runCli(repo, ['verify', '--level', 'G1']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /G1 record, passed 0\.0 hours ago: a newer run failed after it/);
  assert.match(result.stdout, /VERDICT: REFUSED \(the newest run that matters for level G1 failed\)/);
});

test('a file that is not a valid record is reported and never used', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);

  writeFileSync(recordPath(repo, head(repo), 'G0'), '{ half a file');
  const broken = runCli(repo, ['verify']);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /ignored, not a valid record: G0\.json: not valid JSON/);
  assert.match(broken.stdout, /VERDICT: REFUSED \(there is no record for this commit\)/);
});

test('a record that was edited to say "pass" while its check failed is not a record', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['gate'], FAIL).status, 1);

  editRecord(repo, 'G0', (record) => {
    record['result'] = 'pass';
  });

  const result = runCli(repo, ['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ignored, not a valid record: G0\.json: it says "pass" but not every check in it passed/);
});

test('the record of one commit cannot be used for another commit', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  const firstCommit = head(repo);

  writeIn(repo, 'data.txt', 'a second version\n');
  gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: second commit');
  const secondCommit = head(repo);

  mkdirSync(join(repo, '.git', 'gotreceipts', 'records', secondCommit), { recursive: true });
  copyFileSync(recordPath(repo, firstCommit, 'G0'), recordPath(repo, secondCommit, 'G0'));

  const result = runCli(repo, ['verify']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ignored, not a valid record: G0\.json: it is a record of another commit/);
});

test('verify is about the commit, so loose changes in the folder do not change the answer', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  writeIn(repo, 'data.txt', 'edited but not committed\n');

  assert.equal(runCli(repo, ['verify']).status, 0);
});

test('verify runs no checks and writes nothing', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  const before = readFileSync(recordPath(repo, head(repo), 'G0'), 'utf8');

  // If verify ran the check, this would fail it and rewrite the record.
  assert.equal(runCli(repo, ['verify'], FAIL).status, 0);
  assert.equal(readFileSync(recordPath(repo, head(repo), 'G0'), 'utf8'), before);
});

test('a question that cannot be answered is "could not run", never a refusal or a pass', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);

  const noSuchCommit = runCli(repo, ['verify', 'no-such-commit']);
  assert.equal(noSuchCommit.status, 2);
  assert.match(noSuchCommit.stderr, /CANNOT RUN: there is no commit "no-such-commit"/);

  const twoCommits = runCli(repo, ['verify', 'HEAD', 'HEAD']);
  assert.equal(twoCommits.status, 2);

  const unknownLevel = runCli(repo, ['verify', '--level', 'G9']);
  assert.equal(unknownLevel.status, 2);
  assert.match(unknownLevel.stderr, /no level "G9"/);

  assert.equal(runCli(repo, ['verify', '--definitely-not-an-option']).status, 2);

  const noPolicy = tempRepo(t);
  const noPolicyResult = runCli(noPolicy, ['verify']);
  assert.equal(noPolicyResult.status, 2);
  assert.match(noPolicyResult.stderr, /CANNOT RUN: commit \w{7} holds no policy file \(gotreceipts\.json\)/);

  const noCommit = tempRepo(t, { policy: POLICY, commit: false });
  const noCommitResult = runCli(noCommit, ['verify']);
  assert.equal(noCommitResult.status, 2);
  assert.match(noCommitResult.stderr, /CANNOT RUN: the repository has no commit yet/);
});

test('gotreceipts verify --help exits 0', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const result = runCli(repo, ['verify', '--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: gotreceipts verify/);
});
