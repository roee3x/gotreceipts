import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EXIT } from '../src/exit-codes.ts';
import { main, USAGE, type Io } from '../src/main.ts';

/** An Io that records what was written instead of printing it. */
function recorder(): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

test('no command is "could not run", with the usage on stderr', async () => {
  const io = recorder();
  const code = await main([], io);
  assert.equal(code, EXIT.CANNOT_RUN);
  assert.deepEqual(io.outLines, []);
  assert.ok(io.errLines.join('\n').includes('no command given'));
  assert.ok(io.errLines.includes(USAGE));
});

test('an unknown command is "could not run" and names the command', async () => {
  const io = recorder();
  const code = await main(['definitely-not-a-command'], io);
  assert.equal(code, EXIT.CANNOT_RUN);
  assert.deepEqual(io.outLines, []);
  assert.ok(io.errLines.join('\n').includes('unknown command "definitely-not-a-command"'));
});

test('--version prints the version from package.json', async () => {
  for (const flag of ['--version', '-v']) {
    const io = recorder();
    const code = await main([flag], io);
    assert.equal(code, EXIT.PASS);
    assert.deepEqual(io.outLines, [packageVersion()]);
    assert.deepEqual(io.errLines, []);
  }
});

test('--help prints the usage on stdout', async () => {
  for (const flag of ['--help', '-h']) {
    const io = recorder();
    const code = await main([flag], io);
    assert.equal(code, EXIT.PASS);
    assert.deepEqual(io.outLines, [USAGE]);
    assert.deepEqual(io.errLines, []);
  }
});

test('the exit codes are 0, 1 and 2', () => {
  assert.deepEqual(EXIT, { PASS: 0, REFUSED: 1, CANNOT_RUN: 2 });
});
