// Outside-in tests for the record that "gotreceipts gate" writes.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { gitIn, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

const POLICY = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] },
    { name: 'G1', checks: [{ name: 'lint', run: 'node checks/fail.js' }] },
  ],
  tiers: [
    { branch: 'feature/*', level: 'G0' },
    { branch: 'main', level: 'G1' },
  ],
};

function head(repo: string): string {
  return gitIn(repo, 'rev-parse', 'HEAD').stdout.trim();
}

function recordPath(repo: string, commit: string, level: string): string {
  return join(repo, '.git', 'gotreceipts', 'records', commit, `${level}.json`);
}

function readRecord(repo: string, commit: string, level: string): Record<string, any> {
  return JSON.parse(readFileSync(recordPath(repo, commit, level), 'utf8')) as Record<string, any>;
}

test('a passing gate writes a record for the exact commit and level', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const commit = head(repo);
  const before = Date.now();

  const result = runCli(repo, ['gate']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`Record: \\.git/gotreceipts/records/${commit}/G0\\.json`));

  const record = readRecord(repo, commit, 'G0');
  assert.equal(record['schema'], 1);
  assert.equal(record['tool'].name, 'gotreceipts');
  assert.equal(record['commit'], commit);
  assert.equal(record['tree'], gitIn(repo, 'rev-parse', 'HEAD^{tree}').stdout.trim());
  assert.equal(record['branch'], 'feature/thing');
  assert.equal(record['level'], 'G0');
  assert.equal(record['result'], 'pass');
  assert.equal(record['reason'], 'all 1 checks passed');
  assert.match(record['policyId'], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    record['checks'].map((check: any) => [check.name, check.command, check.status, check.exitCode]),
    [['build', 'node checks/pass.js', 'pass', 0]],
  );
  assert.equal(record['platform'].os, process.platform);

  const finished = Date.parse(record['finishedAt']);
  assert.ok(finished >= before - 1000 && finished <= Date.now() + 1000, 'the finish time is the time of the run');
  assert.ok(Date.parse(record['startedAt']) <= finished);
});

test('the policy id in the record is the one "gotreceipts policy" shows', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  const shown = /Policy id: (\S+)/.exec(runCli(repo, ['policy']).stdout)?.[1];
  assert.equal(readRecord(repo, head(repo), 'G0')['policyId'], shown);
});

test('a failing gate writes a record too, with the failed check and the reason', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const commit = head(repo);

  const result = runCli(repo, ['gate', '--level', 'G1']);
  assert.equal(result.status, 1);

  const record = readRecord(repo, commit, 'G1');
  assert.equal(record['result'], 'fail');
  assert.equal(record['reason'], 'the check "lint" failed: exit code 3');
  assert.deepEqual(
    record['checks'].map((check: any) => [check.name, check.status, check.exitCode]),
    [
      ['build', 'pass', 0],
      ['lint', 'fail', 3],
    ],
  );
});

test('each level has its own record, and a newer run replaces the older one of the same level', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const commit = head(repo);

  runCli(repo, ['gate']);
  const first = readRecord(repo, commit, 'G0');
  runCli(repo, ['gate', '--level', 'G1']);
  runCli(repo, ['gate']);
  const second = readRecord(repo, commit, 'G0');

  const files = readdirSync(join(repo, '.git', 'gotreceipts', 'records', commit)).sort();
  assert.deepEqual(files, ['G0.json', 'G1.json']);
  assert.ok(Date.parse(second['finishedAt']) >= Date.parse(first['finishedAt']));
});

test('a new commit gets its own record; the old commit keeps its own', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const firstCommit = head(repo);
  runCli(repo, ['gate']);

  writeIn(repo, 'data.txt', 'a second version\n');
  gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: second commit');
  const secondCommit = head(repo);
  assert.notEqual(secondCommit, firstCommit);

  assert.ok(!existsSync(recordPath(repo, secondCommit, 'G0')), 'the new commit must not inherit a record');
  runCli(repo, ['gate']);
  assert.ok(existsSync(recordPath(repo, firstCommit, 'G0')));
  assert.ok(existsSync(recordPath(repo, secondCommit, 'G0')));
});

test('the record holds no folder path of the machine, no machine name and no home folder', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate', '--level', 'G1']);
  const commit = head(repo);

  for (const level of ['G1']) {
    const text = readFileSync(recordPath(repo, commit, level), 'utf8').toLowerCase();
    const forbidden = [repo, repo.replace(/\\/g, '/'), tmpdir(), homedir(), hostname()];
    for (const secret of forbidden) {
      assert.ok(!text.includes(secret.toLowerCase()), `the record contains "${secret}"`);
    }
  }
});

test('a check that changes the files it checks leaves a failed record that says so', (t) => {
  const repo = tempRepo(t, {
    policy: { ...POLICY, levels: [{ name: 'G0', checks: [{ name: 'format', run: 'node checks/touch.js' }] }, POLICY.levels[1]] },
  });
  const commit = head(repo);

  assert.equal(runCli(repo, ['gate']).status, 1);
  const record = readRecord(repo, commit, 'G0');
  assert.equal(record['result'], 'fail');
  assert.equal(record['reason'], 'the commit or the files changed while the gate was running');
});

test('a gate that could not run writes no record', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeIn(repo, 'data.txt', 'edited but not committed\n');

  assert.equal(runCli(repo, ['gate']).status, 2);
  assert.ok(!existsSync(join(repo, '.git', 'gotreceipts')), 'nothing may be written when the gate did not run');
});

test('the record is not something git would commit', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['gate']);
  assert.equal(gitIn(repo, 'status', '--porcelain', '--untracked-files=all').stdout, '');
});

test('a second worktree of the repository writes its records to the same shared place', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const worktree = `${repo}-worktree`;
  t.after(() => gitIn(repo, 'worktree', 'remove', '--force', worktree));
  const added = gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'feature/other', worktree);
  assert.equal(added.status, 0, added.stderr);

  const result = runCli(worktree, ['gate']);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const commit = head(worktree);
  const record = readRecord(repo, commit, 'G0');
  assert.equal(record['branch'], 'feature/other');
});
