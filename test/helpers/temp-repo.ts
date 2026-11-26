// Shared by the outside-in tests: a small git repository in a temporary folder,
// with a few tiny scripts that stand in for a project's real checks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Runs the built tool in `cwd`. */
export function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The last line of some output that is not empty. */
export function lastLine(text: string): string {
  return text.trimEnd().split('\n').at(-1)?.trimEnd() ?? '';
}
