// Shared by the outside-in tests: a small git repository in a temporary folder,
// with a few tiny scripts that stand in for a project's real checks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** The stand-in checks. Each is one line of JavaScript, run with "node checks/<name>.js". */
const CHECK_SCRIPTS: Record<string, string> = {
  // Exits 0 and prints a line.
  'pass.js': "console.log('all good');\n",
  // Exits with code 3.
  'fail.js': "console.log('about to fail'); process.exit(3);\n",
  // Prints "<n> ran" and exits 0, whatever n is. Like a test runner that found no tests.
  'count.js': "console.log(process.argv[2] + ' ran');\n",
  // Never finishes on its own.
  'slow.js': 'setTimeout(() => {}, 600000);\n',
  // Passes, unless the environment says to fail. Like a check that passes on one run and fails on the next.
  'flaky.js': "process.exit(process.env.GOTRECEIPTS_TEST_FAIL === '1' ? 1 : 0);\n",
  // Changes a tracked file, like a formatter that rewrites the code it checks.
  'touch.js': "require('node:fs').appendFileSync('data.txt', 'changed\\n');\n",
};

/** A fixed identity for the commits of the temporary repository, so no machine setting is needed. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function gitIn(cwd: string, ...args: string[]): RunResult {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function writeIn(folder: string, relativePath: string, content: string): string {
  const fullPath = join(folder, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

export interface RepoOptions {
  /** The policy to write as gotreceipts.json. Leave out for a repository with no policy. */
  readonly policy?: unknown;
  /** The branch to create. */
  readonly branch?: string;
  /** Set to false for a repository with files but no commit. */
  readonly commit?: boolean;
}

/**
 * Makes a git repository with the stand-in checks, a tracked data file and (usually) a policy,
 * all committed, and removes it when the test ends.
 */
export function tempRepo(t: TestContext, options: RepoOptions = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'gotreceipts-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  const branch = options.branch ?? 'feature/thing';
  const init = gitIn(repo, 'init', '--quiet', `--initial-branch=${branch}`);
  assert.equal(init.status, 0, init.stderr);

  for (const [name, source] of Object.entries(CHECK_SCRIPTS)) {
    writeIn(repo, `checks/${name}`, source);
  }
  writeIn(repo, 'data.txt', 'original\n');
  // The checks are CommonJS scripts, whatever the folder above the temporary one says.
  writeIn(repo, 'package.json', '{ "private": true }\n');
  if (options.policy !== undefined) {
    writeIn(repo, 'gotreceipts.json', `${JSON.stringify(options.policy, null, 2)}\n`);
  }

  if (options.commit !== false) {
    assert.equal(gitIn(repo, 'add', '--all').status, 0);
    const commit = gitIn(repo, 'commit', '--quiet', '-m', 'test: starting point');
    assert.equal(commit.status, 0, commit.stderr);
  }
  return repo;
}

/** Runs the built tool in `cwd`. `input` is what the tool reads, as if it were piped to it. */
export function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}, input = ''): RunResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Makes an empty repository that `repo` can push to, the way a server would hold it,
 * and adds it to `repo` under the name "origin". Returns its folder.
 */
export function addRemote(t: TestContext, repo: string): string {
  const remote = mkdtempSync(join(tmpdir(), 'gotreceipts-remote-'));
  t.after(() => rmSync(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  assert.equal(gitIn(remote, 'init', '--quiet', '--bare').status, 0);
  assert.equal(gitIn(repo, 'remote', 'add', 'origin', remote).status, 0);
  return remote;
}

/** Puts a pre-push hook in the repository that calls the built tool, like an installed hook would. */
export function installPushHook(repo: string): void {
  const node = process.execPath.replace(/\\/g, '/');
  const cli = cliPath.replace(/\\/g, '/');
  const path = writeIn(repo, '.git/hooks/pre-push', `#!/bin/sh\nexec "${node}" "${cli}" hook pre-push "$@"\n`);
  chmodSync(path, 0o755);
}

/**
 * An environment in which git reads no settings and no ignore list of the person running the
 * tests. Some machines ignore a file for every repository. A test about what git ignores must
 * mean the same on every machine, so it runs with this.
 */
export function noPersonalGitSettings(t: TestContext): Record<string, string> {
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-gitconfig-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const empty = join(folder, 'gitconfig');
  writeFileSync(empty, '');
  return { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: folder };
}

/** What git lists as changed or new in `repo`, one file per line. Empty when the folder is clean. */
export function looseFiles(repo: string, extraEnv: Record<string, string> = {}): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** The last line of some output that is not empty. */
export function lastLine(text: string): string {
  return text.trimEnd().split('\n').at(-1)?.trimEnd() ?? '';
}

/** A signing key made for one test: no passphrase, in a folder of its own, removed when the test ends. */
export interface TestKey {
  /** The file of the private half. */
  readonly file: string;
  /** The public half as a policy lists it: the type and the body, with no comment. */
  readonly publicKey: string;
}

export function testKey(t: TestContext): TestKey {
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-key-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = join(folder, 'key');
  const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', file], { encoding: 'utf8' });
  assert.equal(made.status, 0, `ssh-keygen could not make a test key: ${made.error?.message ?? made.stderr}`);
  const publicKey = readFileSync(`${file}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  return { file, publicKey };
}

/**
 * Puts an approval into the repository without the "approve" command: any text, signed with any
 * key, for any purpose. This is what someone would do who wants to make an approval by hand.
 */
export function plantApproval(
  t: TestContext,
  repo: string,
  place: { readonly commit: string; readonly branch: string },
  text: string,
  key: TestKey,
  purpose = 'gotreceipts-approval',
): void {
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-planted-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const statement = join(folder, 'approval.json');
  writeFileSync(statement, text);
  const signed = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', key.file, '-n', purpose, statement], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);

  const name = `${encodeURIComponent(place.branch)}.json`;
  writeIn(repo, `.git/gotreceipts/approvals/${place.commit}/${name}`, text);
  writeIn(repo, `.git/gotreceipts/approvals/${place.commit}/${name}.sig`, readFileSync(`${statement}.sig`, 'utf8'));
}
