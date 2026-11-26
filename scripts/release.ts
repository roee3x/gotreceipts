// Publishes the package to npm, and refuses unless this is a release that passed the gate.
//
// A version on npm cannot be replaced once it is out. So the last step gets the same rule
// as a merge: no receipt, no release.
//
// It publishes only when all of these hold:
//   1. There are no uncommitted changes.
//   2. The current commit carries the tag of this version: "v" plus the version in package.json.
//   3. The current commit is on the main branch, as last fetched from GitHub.
//   4. A fresh build succeeds, so the package holds exactly what this commit builds.
//   5. The commit has a record that is good enough for main.
//
// Usage: npm run release              publishes
//        npm run release -- --dry-run does everything except the upload
// Anything after "--" is handed to "npm publish".
//
// Exit codes: 0 published, 1 refused, 2 could not run.
//
// Known limit: this guard is a separate command, not an npm lifecycle script. This repository
// switches lifecycle scripts off (see .npmrc), so a script named "prepublishOnly" would be
// skipped in silence. A bare "npm publish" therefore does not pass through this guard.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publishArgs = process.argv.slice(2);
const dryRun = publishArgs.includes('--dry-run');

/** A rule of the release was not met. */
class Refusal extends Error {}
/** A step could not run at all. That is never treated as a pass. */
class CouldNotRun extends Error {}

/** Runs git and returns its exit code and what it printed. */
function git(...args: string[]): { status: number; out: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status === null) {
    throw new CouldNotRun(`git ${args[0] ?? ''} could not run`);
  }
  return { status: result.status, out: result.stdout.trim() };
}

/** Runs one command line with its output shown live, and returns its exit code. */
function runShown(commandLine: string): number {
  const result = spawnSync(commandLine, { cwd: root, shell: true, stdio: 'inherit', windowsHide: true });
  if (result.error !== undefined || result.status === null) {
    throw new CouldNotRun(`could not run: ${commandLine}`);
  }
  return result.status;
}

/** Checks the five rules. Returns the package name and version, or throws. */
function checkRelease(): { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
  const tag = `v${manifest.version}`;

  // 1. Nothing uncommitted.
  const status = git('status', '--porcelain', '--untracked-files=all');
  if (status.status !== 0) throw new CouldNotRun('git status failed');
  if (status.out !== '') throw new Refusal('there are uncommitted changes');

  // 2. The commit carries this version's tag.
  const tags = git('tag', '--points-at', 'HEAD');
  if (tags.status !== 0) throw new CouldNotRun('git tag failed');
  if (!tags.out.split(/\r?\n/).includes(tag)) {
    throw new Refusal(`this commit does not carry the tag ${tag}. A release is published from its tagged commit`);
  }

  // 3. The commit is on main.
  if (git('merge-base', '--is-ancestor', 'HEAD', 'origin/main').status !== 0) {
    throw new Refusal('this commit is not on the main branch');
  }

  // 4. A fresh build.
  if (runShown('npm run build') !== 0) throw new Refusal('the build failed');

  // 5. The record. The tool that was just built reads it.
  const verify = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'verify', '--for', 'main'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (verify.error !== undefined || verify.status === null) throw new CouldNotRun('the verify command could not run');
  if (verify.status === 2) throw new CouldNotRun('the verify command could not check the record');
  if (verify.status !== 0) throw new Refusal('this commit has no record that is good enough for main');

  return manifest;
}

try {
  const { name, version } = checkRelease();
  console.log(`release: ${name}@${version} is tagged, on main, freshly built, and has its record.`);

  const status = runShown(['npm publish', ...publishArgs].join(' '));
  if (status !== 0) {
    console.log(`release: FAILED (npm publish ended with exit code ${status}, and nothing was published)`);
    process.exitCode = 2;
  } else if (dryRun) {
    console.log(`release: DRY RUN PASSED (${name}@${version} is ready, and nothing was published)`);
  } else {
    console.log(`release: PUBLISHED (${name}@${version})`);
  }
} catch (error) {
  if (error instanceof Refusal) {
    console.log(`release: REFUSED (${error.message})`);
    process.exitCode = 1;
  } else {
    // An unexpected error is never allowed to look like a pass.
    console.log(`release: COULD NOT RUN (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 2;
  }
}
