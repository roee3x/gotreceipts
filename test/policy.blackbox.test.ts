// Outside-in tests for "gotreceipts policy".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const VALID_POLICY = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [{ name: 'build', run: 'npm run build' }, { name: 'test', run: 'npm test' }] },
    { name: 'G1', checks: [{ name: 'words', run: 'gotreceipts words' }] },
  ],
  tiers: [
    { branch: 'feature/*', level: 'G0' },
    { branch: 'main', level: 'G1' },
  ],
};

/** Makes a temporary git repository and removes it when the test ends. */
function sandbox(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), 'gotreceipts-policy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '--quiet'], { cwd: base, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return base;
}

function run(cwd: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, 'policy', ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a valid policy exits 0 and shows the levels, the branches and the policy id', (t) => {
  const repo = sandbox(t);
  writeFileSync(join(repo, 'gotreceipts.json'), JSON.stringify(VALID_POLICY, null, 2));

  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The policy is valid\./);
  assert.match(result.stdout, /Policy id: sha256:[0-9a-f]{64}/);
  assert.match(result.stdout, /G0 {2}2 checks: build, test/);
  assert.match(result.stdout, /G1 {2}3 checks: build, test, words/);
  assert.match(result.stdout, /feature\/\* {2}G0/);
  assert.match(result.stdout, /main {7}G1/);
  assert.match(result.stdout, /A record counts for 24 hours\./);
});

test('the policy is found from a subfolder of the repository', (t) => {
  const repo = sandbox(t);
  writeFileSync(join(repo, 'gotreceipts.json'), JSON.stringify(VALID_POLICY));
  const deep = join(repo, 'src', 'deep');
  mkdirSync(deep, { recursive: true });

  assert.equal(run(deep).status, 0);
});

test('a missing policy file is "could not run"', (t) => {
  const repo = sandbox(t);
  const result = run(repo);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: no policy file at/);
  assert.equal(result.stdout, '');
});

test('a policy with errors is "could not run", and every error is listed with its place', (t) => {
  const repo = sandbox(t);
  const broken = structuredClone(VALID_POLICY) as Record<string, any>;
  broken['levels'][0].checks[0].run = 'npm run build | tee log.txt';
  broken['tiers'][1].level = 'G7';
  broken['surprise'] = true;
  writeFileSync(join(repo, 'gotreceipts.json'), JSON.stringify(broken));

  const result = run(repo);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gotreceipts\.json: surprise: unknown setting/);
  assert.match(result.stderr, /gotreceipts\.json: levels\[0\]\.checks\[0\]\.run: contains a pipe/);
  assert.match(result.stderr, /gotreceipts\.json: tiers\[1\]\.level: must be the name of a level \(G0, G1\)/);
  assert.equal(result.stdout, '');
});

test('--file reads a policy from another place', (t) => {
  const repo = sandbox(t);
  const elsewhere = join(repo, 'config', 'other.json');
  mkdirSync(dirname(elsewhere), { recursive: true });
  writeFileSync(elsewhere, JSON.stringify(VALID_POLICY));

  assert.equal(run(repo, ['--file', elsewhere]).status, 0);
});

test('the same policy in a different layout has the same id', (t) => {
  const repo = sandbox(t);
  const id = (text: string): string => {
    writeFileSync(join(repo, 'gotreceipts.json'), text);
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    return /Policy id: (\S+)/.exec(result.stdout)?.[1] ?? '';
  };

  const compact = id(JSON.stringify(VALID_POLICY));
  const pretty = id(JSON.stringify(VALID_POLICY, null, 4));
  assert.equal(compact, pretty);

  const changed = structuredClone(VALID_POLICY);
  changed.levels[0]!.checks[1]!.run = 'echo ok';
  assert.notEqual(id(JSON.stringify(changed)), compact);
});

test('gotreceipts policy --help exits 0, and an unknown option exits 2', (t) => {
  const repo = sandbox(t);
  assert.equal(run(repo, ['--help']).status, 0);
  assert.equal(run(repo, ['--definitely-not-an-option']).status, 2);
});
