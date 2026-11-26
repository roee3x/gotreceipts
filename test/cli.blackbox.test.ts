// Outside-in tests: they run the built tool the way a user or a hook would,
// and only look at its exit code and its output.
// They do not import the tool's code, so a version written in another language can reuse them.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

test('the tool is built (run "npm run build" before the tests)', () => {
  assert.ok(existsSync(cliPath), `missing ${cliPath}`);
});

test('gotreceipts --version exits 0 and prints the version', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageVersion());
  assert.equal(result.stderr, '');
});

test('gotreceipts --help exits 0 and explains the exit codes', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: gotreceipts/);
  assert.match(result.stdout, /0 = pass, 1 = refused, 2 = could not run/);
});

test('gotreceipts with no command exits 2 and prints nothing on stdout', () => {
  const result = run();
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no command given/);
});

test('gotreceipts with an unknown command exits 2', () => {
  const result = run('definitely-not-a-command');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown command "definitely-not-a-command"/);
});
