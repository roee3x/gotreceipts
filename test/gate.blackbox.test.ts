// Outside-in tests for "gotreceipts gate".

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gitIn, lastLine, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

interface CheckSpec {
  name: string;
  run: string;
  timeoutMinutes?: number;
  expect?: unknown;
}

/** A policy with two levels: G0 holds `g0`, G1 adds `g1`. */
function policy(g0: CheckSpec[], g1: CheckSpec[] = []): unknown {
  return {
    schema: 1,
    levels: [
      { name: 'G0', checks: g0 },
      { name: 'G1', checks: g1 },
    ],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'main', level: 'G1' },
    ],
  };
}

const PASS: CheckSpec = { name: 'build', run: 'node checks/pass.js' };
const FAIL: CheckSpec = { name: 'lint', run: 'node checks/fail.js' };

test('every check passes: exit 0, each check is listed, and the last line is the verdict', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS, { name: 'second', run: 'node checks/pass.js' }]) });
  const head = gitIn(repo, 'rev-parse', '--short=7', 'HEAD').stdout.trim();

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`level G0 on commit ${head} \\(branch feature/thing\\)`));
  assert.match(result.stdout, /2 checks to run: build, second/);
  assert.match(result.stdout, /\[1\/2\] build: node checks\/pass\.js/);
  assert.match(result.stdout, /all good/);
  assert.match(result.stdout, /\[1\/2\] build: PASS \(exit code 0, \d+\.\d s\)/);
  assert.match(result.stdout, /\[2\/2\] second: PASS/);
  assert.equal(lastLine(result.stdout), `VERDICT: PASS (level G0, commit ${head})`);
});

test('a failing check: exit 1, its exit code is shown, and the checks after it are skipped', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS, FAIL, { name: 'after', run: 'node checks/pass.js' }]) });

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[1\/3\] build: PASS/);
  assert.match(result.stdout, /\[2\/3\] lint: FAIL \(exit code 3, /);
  assert.match(result.stdout, /\[3\/3\] after: SKIPPED \(an earlier check failed\)/);
  assert.match(lastLine(result.stdout), /^VERDICT: FAIL \(level G0, commit [0-9a-f]{7}\)$/);
});

test('exit code 0 is not enough when the expected line is missing', (t) => {
  const repo = tempRepo(t, {
    policy: policy([{ name: 'build', run: 'node checks/pass.js', expect: { output: 'BUILD SUCCEEDED' } }]),
  });

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /build: FAIL \(exit code 0, but the output does not contain the expected line/);
});

test('a test run that ran zero tests fails, even with exit code 0', (t) => {
  const counted = (n: number): CheckSpec => ({
    name: 'test',
    run: `node checks/count.js ${n}`,
    expect: { count: { pattern: '(\\d+) ran', atLeast: 1 } },
  });

  const zero = tempRepo(t, { policy: policy([counted(0)]) });
  const zeroResult = runCli(zero, ['gate']);
  assert.equal(zeroResult.status, 1);
  assert.match(zeroResult.stdout, /test: FAIL \(exit code 0, but the output shows a count of 0, and at least 1 is needed/);

  const some = tempRepo(t, { policy: policy([counted(7)]) });
  assert.equal(runCli(some, ['gate']).status, 0);
});

test('a check that runs too long is stopped and fails', (t) => {
  const repo = tempRepo(t, {
    policy: policy([{ name: 'hang', run: 'node checks/slow.js', timeoutMinutes: 0.02 }]),
  });

  const started = Date.now();
  const result = runCli(repo, ['gate']);
  const elapsedSeconds = (Date.now() - started) / 1000;

  assert.equal(result.status, 1);
  assert.match(result.stdout, /hang: FAIL \(timed out after 0\.02 minutes/);
  assert.ok(elapsedSeconds < 60, `the gate took ${elapsedSeconds} s to stop a 1.2 s timeout`);
});

test('uncommitted changes: the gate does not run, and says which files', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS]) });
  writeIn(repo, 'data.txt', 'edited but not committed\n');
  writeIn(repo, 'new-file.txt', 'new and not committed\n');

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: there are uncommitted changes/);
  assert.match(result.stderr, /data\.txt/);
  assert.match(result.stderr, /new-file\.txt/);
  assert.equal(result.stdout, '', 'no check may have run');
});

test('a check that changes the files it checks fails the gate', (t) => {
  const repo = tempRepo(t, { policy: policy([{ name: 'format', run: 'node checks/touch.js' }]) });

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /format: PASS/);
  assert.match(result.stdout, /changed while the gate was running/);
  assert.match(lastLine(result.stdout), /^VERDICT: FAIL/);
});

test('a higher level runs the checks of the lower levels first', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS], [{ name: 'extra', run: 'node checks/pass.js' }]) });

  const result = runCli(repo, ['gate', '--level', 'G1']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 checks to run: build, extra/);
  assert.match(lastLine(result.stdout), /^VERDICT: PASS \(level G1, /);
});

test('--for runs the level a commit needs to enter that branch', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS], [FAIL]) });

  // On feature/thing the branch's own level is G0, which passes.
  assert.equal(runCli(repo, ['gate']).status, 0);
  // Entering main needs G1, which adds the failing check.
  const forMain = runCli(repo, ['gate', '--for', 'main']);
  assert.equal(forMain.status, 1);
  assert.match(forMain.stdout, /level G1 on commit/);
});

test('a level that cannot be worked out is "could not run"', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS]), branch: 'scratch' });

  const noTier = runCli(repo, ['gate']);
  assert.equal(noTier.status, 2);
  assert.match(noTier.stderr, /no tier for the branch "scratch", so give --level or --for/);

  const unknownLevel = runCli(repo, ['gate', '--level', 'G9']);
  assert.equal(unknownLevel.status, 2);
  assert.match(unknownLevel.stderr, /no level "G9"/);

  const both = runCli(repo, ['gate', '--level', 'G0', '--for', 'main']);
  assert.equal(both.status, 2);

  // With the level given, the same repository runs.
  assert.equal(runCli(repo, ['gate', '--level', 'G0']).status, 0);
});

test('no policy, a broken policy, or no commit is "could not run"', (t) => {
  const noPolicy = tempRepo(t);
  const noPolicyResult = runCli(noPolicy, ['gate']);
  assert.equal(noPolicyResult.status, 2);
  assert.match(noPolicyResult.stderr, /CANNOT RUN: commit \w{7} holds no policy file \(gotreceipts\.json\)\. Only a committed policy counts/);

  const broken = tempRepo(t, { policy: { schema: 1, levels: [], tiers: [] } });
  const brokenResult = runCli(broken, ['gate']);
  assert.equal(brokenResult.status, 2);
  assert.match(brokenResult.stderr, /gotreceipts\.json: levels: must be a list with at least one level/);

  const noCommit = tempRepo(t, { policy: policy([PASS]), commit: false });
  const noCommitResult = runCli(noCommit, ['gate']);
  assert.equal(noCommitResult.status, 2);
  assert.match(noCommitResult.stderr, /CANNOT RUN: the repository has no commit yet/);
});

test('a command that does not exist fails the check', (t) => {
  const repo = tempRepo(t, { policy: policy([{ name: 'ghost', run: 'definitely-not-a-real-command-xyz' }]) });

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ghost: FAIL \(exit code \d+/);
});

test('gotreceipts gate --help exits 0, and an unknown option exits 2', (t) => {
  const repo = tempRepo(t, { policy: policy([PASS]) });
  assert.equal(runCli(repo, ['gate', '--help']).status, 0);
  assert.equal(runCli(repo, ['gate', '--definitely-not-an-option']).status, 2);
});
