// Outside-in tests for "gotreceipts words".
// Each test makes a small git repository in a temporary folder, runs the built tool in it,
// and only looks at the exit code and the output.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

interface Sandbox {
  /** A git repository. */
  readonly repo: string;
  /** A folder outside the repository, for the word list. */
  readonly outside: string;
}

/** Makes a temporary git repository and removes it when the test ends. */
function sandbox(t: TestContext): Sandbox {
  const base = mkdtempSync(join(tmpdir(), 'gotreceipts-words-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  const init = spawnSync('git', ['init', '--quiet'], { cwd: repo, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return { repo, outside };
}

function write(folder: string, relativePath: string, content: string): string {
  const fullPath = join(folder, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

function run(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!('GOTRECEIPTS_PRIVATE_WORDS' in extraEnv)) delete env['GOTRECEIPTS_PRIVATE_WORDS'];
  const result = spawnSync(process.execPath, [cliPath, 'words', ...args], { cwd, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a clean repository passes, and the last line is the verdict', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\nQuillon\n');
  write(repo, 'README.md', 'Nothing private here.\n');
  write(repo, 'src/app.ts', 'export const answer = 42;\n');

  const result = run(repo, ['--list', list]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked 2 files against 2 entries\./);
  assert.equal(result.stdout.trimEnd().split('\n').at(-1), 'VERDICT: PASS');
});

test('a private word in a file fails, and the word itself is not printed', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', '# clients\nZorblax\n');
  write(repo, 'src/app.ts', 'line one\nbuilt for zorblax in a week\n');

  const result = run(repo, ['--list', list]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FOUND {2}src\/app\.ts:2 {2}entry on list line 2: Z\*{6}/);
  assert.equal(result.stdout.trimEnd().split('\n').at(-1), 'VERDICT: FAIL');
  assert.doesNotMatch(result.stdout + result.stderr, /zorblax/i);
});

test('--show-words prints the entry that was found', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, 'notes.txt', 'built for Zorblax\n');

  const result = run(repo, ['--list', list, '--show-words']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /entry on list line 1: Zorblax/);
});

test('a private word in a file path fails, and the path is shown with the word hidden', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, 'clients/zorblax/plan.md', 'nothing private inside\n');

  const result = run(repo, ['--list', list]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FOUND {2}clients\/Z\*{6}\/plan\.md \(the file path\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /zorblax/i);
});

test('a private word in the message file fails', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, 'README.md', 'clean\n');
  const message = write(outside, 'message.txt', 'fix: a bug\n\nFound while working for Zorblax.\n');

  const result = run(repo, ['--list', list, '--message', message]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Checked 1 files and the message against 1 entries\./);
  assert.match(result.stdout, /FOUND {2}message:3 /);
});

test('a look-alike inside a longer word passes', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'art\n');
  write(repo, 'LICENSE', 'FITNESS FOR A PARTICULAR PURPOSE\n');

  const result = run(repo, ['--list', list]);
  assert.equal(result.status, 0, result.stdout);
});

test('files that git ignores are not checked, new files that are not ignored are', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, '.gitignore', 'build/\n');
  write(repo, 'build/output.txt', 'Zorblax\n');
  write(repo, 'src/clean.ts', 'export {};\n');

  const ignoredOnly = run(repo, ['--list', list]);
  assert.equal(ignoredOnly.status, 0, ignoredOnly.stdout);

  write(repo, 'src/new-file.ts', '// for Zorblax\n');
  const withNewFile = run(repo, ['--list', list]);
  assert.equal(withNewFile.status, 1);
  assert.match(withNewFile.stdout, /src\/new-file\.ts:1/);
});

test('the check works from a subfolder of the repository', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, 'top.txt', 'Zorblax\n');
  write(repo, 'deep/inside/file.txt', 'clean\n');

  const result = run(join(repo, 'deep', 'inside'), ['--list', list]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FOUND {2}top\.txt:1/);
});

test('the list can come from the environment variable', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, 'notes.txt', 'Zorblax\n');

  const result = run(repo, [], { GOTRECEIPTS_PRIVATE_WORDS: list });
  assert.equal(result.status, 1);
});

test('the list is found in the home folder when nothing else is given', (t) => {
  const { repo, outside } = sandbox(t);
  write(outside, '.gotreceipts/private-words.txt', 'Zorblax\n');
  write(repo, 'notes.txt', 'Zorblax\n');

  // Node reads the home folder from HOME on Linux and macOS and from USERPROFILE on Windows.
  const result = run(repo, [], { HOME: outside, USERPROFILE: outside });
  assert.equal(result.status, 1);
});

test('a missing list is "could not run", not a pass', (t) => {
  const { repo, outside } = sandbox(t);
  write(repo, 'notes.txt', 'anything\n');

  const result = run(repo, ['--list', join(outside, 'no-such-list.txt')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: no word list at/);
  assert.equal(result.stdout, '');
});

test('a list with no entries is "could not run", not a pass', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', '# only a comment\n\n');
  write(repo, 'notes.txt', 'anything\n');

  const result = run(repo, ['--list', list]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: the word list has no entries/);
});

test('a folder that is not a git repository is "could not run"', (t) => {
  const { outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');

  // GIT_CEILING_DIRECTORIES stops git from finding a repository further up the folder tree.
  const result = run(outside, ['--list', list], { GIT_CEILING_DIRECTORIES: dirname(outside) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: this folder is not inside a git repository/);
});

test('a missing message file is "could not run"', (t) => {
  const { repo, outside } = sandbox(t);
  const list = write(outside, 'words.txt', 'Zorblax\n');
  write(repo, 'notes.txt', 'clean\n');

  const result = run(repo, ['--list', list, '--message', join(outside, 'no-such-message.txt')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: no message file at/);
});

test('an unknown option is "could not run"', (t) => {
  const { repo } = sandbox(t);
  const result = run(repo, ['--definitely-not-an-option']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: gotreceipts words/);
});

test('gotreceipts words --help exits 0', (t) => {
  const { repo } = sandbox(t);
  const result = run(repo, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: gotreceipts words/);
});
