// The test runner wrapper must fail when no test ran.
// These tests run it the way "npm test" does and only look at the exit code and the output.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const runner = fileURLToPath(new URL('../scripts/run-tests.ts', import.meta.url));

function runRunner(...patterns: string[]): { status: number | null; stdout: string; stderr: string } {
  // Node marks test processes with this variable and refuses to start a test run inside one.
  // The runner is started here the way "npm test" starts it: without that mark.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];

  const result = spawnSync(process.execPath, [runner, ...patterns], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a pattern that matches no file fails: zero tests is not a pass', () => {
  const result = runRunner('no-such-folder/**/*.test.ts');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no test ran/);
});

test('a file with a failing test fails', () => {
  const result = runRunner('test/fixtures/failing.fixture.ts');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 failed/);
});

test('a file with a passing test passes and reports the count', () => {
  const result = runRunner('test/fixtures/passing.fixture.ts');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 ran, 0 failed/);
});

test('a file where every test is skipped fails: nothing really ran', () => {
  const result = runRunner('test/fixtures/skipped.fixture.ts');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no test ran/);
});

test('no pattern at all is "could not run"', () => {
  const result = runRunner();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /give at least one file pattern/);
});
