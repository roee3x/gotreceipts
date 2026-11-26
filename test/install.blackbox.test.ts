// Outside-in tests for "gotreceipts install", "uninstall" and "doctor".

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { addRemote, gitIn, lastLine, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

const POLICY = {
  schema: 1,
  levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
  tiers: [{ branch: 'feature/*', level: 'G0' }],
};

function hookPath(repo: string, name = 'pre-push'): string {
  return join(repo, '.git', 'hooks', name);
}

/** Writes a hook the way a person or another tool would, before this tool arrives. */
function writeForeignHook(repo: string, body: string, name = 'pre-push'): void {
  const path = writeIn(repo, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function remoteHas(remote: string, branch: string): boolean {
  return gitIn(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0;
}

// --- install ---

test('install writes the hook and reports what is enforced and what is not', (t) => {
  const repo = tempRepo(t, { policy: POLICY });

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /gotreceipts install: done\./);
  assert.match(result.stdout, /pre-push hook: written/);
  assert.match(result.stdout, /policy file\s+OK: 1 level, and a level is set for feature\/\*/);
  assert.match(result.stdout, /git pre-push hook\s+INSTALLED/);
  assert.match(result.stdout, /This clone stops:\n {2}- "git push" of a commit that has no valid record/);
  assert.match(result.stdout, /It does not stop:\n {2}- "git push --no-verify"/);
  assert.match(result.stdout, /A merge made on the server/);
  assert.equal(lastLine(result.stdout), 'VERDICT: PASS (the push hook is in place)');

  assert.match(readFileSync(hookPath(repo), 'utf8'), /^# gotreceipts:managed-hook pre-push$/m);
});

test('installing twice is safe: the hook is written again and nothing is kept aside', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);

  const again = runCli(repo, ['install']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /pre-push hook: was already there, written again/);
  assert.equal(existsSync(hookPath(repo, 'pre-push.local')), false);
});

test('the installed hook stops a real push without a record, and lets one with a record through', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  assert.equal(runCli(repo, ['install']).status, 0);

  const refused = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /VERDICT: REFUSED \(the pushed commit has no valid record\)/);
  assert.equal(remoteHas(remote, 'feature/thing'), false);

  assert.equal(runCli(repo, ['gate']).status, 0);
  const allowed = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.equal(remoteHas(remote, 'feature/thing'), true);
});

test('a hook that was already there is kept, and it runs first with the same input', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  // The older hook writes down what git told it.
  writeForeignHook(repo, 'cat > "$(dirname "$0")/older-hook-saw.txt"');

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /The hook that was there is kept as pre-push\.local and runs first/);
  assert.match(result.stdout, /an older hook, pre-push\.local, runs before it/);
  assert.match(readFileSync(hookPath(repo, 'pre-push.local'), 'utf8'), /older-hook-saw/);

  assert.equal(runCli(repo, ['gate']).status, 0);
  const push = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.equal(push.status, 0, push.stdout + push.stderr);
  assert.match(readFileSync(hookPath(repo, 'older-hook-saw.txt'), 'utf8'), /refs\/heads\/feature\/thing/);
  assert.match(push.stdout + push.stderr, /VERDICT: PASS \(1 pushed commit has a valid record\)/);
  assert.equal(remoteHas(remote, 'feature/thing'), true);
});

test('when the older hook says no, the push stops there, record or not', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  writeForeignHook(repo, 'echo "the older hook says no" >&2\nexit 7');
  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(runCli(repo, ['gate']).status, 0);

  const push = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /the older hook says no/);
  assert.equal(remoteHas(remote, 'feature/thing'), false);
});

test('with two older hooks in the way, install changes nothing and says why', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeForeignHook(repo, 'echo first');
  writeForeignHook(repo, 'echo second', 'pre-push.local');

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REFUSED: a pre-push hook that this tool did not write is there, and so is pre-push\.local/);
  assert.equal(lastLine(result.stdout), 'Nothing was changed.');
  assert.match(readFileSync(hookPath(repo), 'utf8'), /echo first/);
  assert.match(readFileSync(hookPath(repo, 'pre-push.local'), 'utf8'), /echo second/);
});

test('when git reads hooks from another folder, install writes nothing and gives the line to add', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(gitIn(repo, 'config', 'core.hooksPath', '.shared-hooks').status, 0);

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REFUSED: git looks for hooks in "\.shared-hooks" \(the setting core\.hooksPath\)/);
  assert.match(result.stdout, /^ {2}gotreceipts hook pre-push "\$@"$/m);
  assert.equal(existsSync(hookPath(repo)), false);

  const doctor = runCli(repo, ['doctor']);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /NOT INSTALLED: git looks for hooks in "\.shared-hooks"/);
});

test('install needs a policy first, because the hook would block every push without one', (t) => {
  const repo = tempRepo(t);
  const result = runCli(repo, ['install']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gotreceipts install: CANNOT RUN: no policy file at/);
  assert.equal(existsSync(hookPath(repo)), false);
});

test('outside a git repository the three commands cannot run', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-plain-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const command of ['install', 'uninstall', 'doctor']) {
    const result = runCli(folder, [command]);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /not inside a git repository/, command);
  }
});

test('each command explains itself, and refuses an option it does not know', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  for (const command of ['install', 'uninstall', 'doctor']) {
    const help = runCli(repo, [command, '--help']);
    assert.equal(help.status, 0, command);
    assert.match(help.stdout, new RegExp(`^Usage: gotreceipts ${command}`), command);
    assert.equal(runCli(repo, [command, '--force']).status, 2, command);
  }
  assert.equal(existsSync(hookPath(repo)), false, 'asking for help installs nothing');
});

// --- uninstall ---

test('uninstall removes the hook, and a push is no longer checked', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  assert.equal(runCli(repo, ['install']).status, 0);

  const result = runCli(repo, ['uninstall']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pre-push hook: removed/);
  assert.equal(lastLine(result.stdout), 'From now on, a push from this clone is not checked.');
  assert.equal(existsSync(hookPath(repo)), false);

  assert.equal(gitIn(repo, 'push', 'origin', 'feature/thing').status, 0);
  assert.equal(remoteHas(remote, 'feature/thing'), true);
});

test('uninstall puts an older hook back exactly as it was', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeForeignHook(repo, 'echo "I was here first"');
  const before = readFileSync(hookPath(repo), 'utf8');
  assert.equal(runCli(repo, ['install']).status, 0);

  const result = runCli(repo, ['uninstall']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /The hook kept as pre-push\.local is back in its place/);
  assert.equal(readFileSync(hookPath(repo), 'utf8'), before);
  assert.equal(existsSync(hookPath(repo, 'pre-push.local')), false);
});

test('uninstall never touches a hook this tool did not write', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeForeignHook(repo, 'echo "not yours"');

  const result = runCli(repo, ['uninstall']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /a hook is there that this tool did not write\. It was left as it is/);
  assert.match(readFileSync(hookPath(repo), 'utf8'), /not yours/);
});

test('uninstall with nothing installed says so, and works even when the policy is gone', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.match(runCli(repo, ['uninstall']).stdout, /was not installed, nothing to remove/);

  assert.equal(runCli(repo, ['install']).status, 0);
  rmSync(join(repo, 'gotreceipts.json'));
  const result = runCli(repo, ['uninstall']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(hookPath(repo)), false);
});

// --- doctor ---

test('doctor says "not protected" before install, and "pass" after', (t) => {
  const repo = tempRepo(t, { policy: POLICY });

  const before = runCli(repo, ['doctor']);
  assert.equal(before.status, 1);
  assert.match(before.stdout, /git pre-push hook\s+NOT INSTALLED/);
  assert.match(before.stdout, /This clone stops:\n {2}- Nothing\. No hook of this tool is in place\./);
  assert.match(before.stdout, /VERDICT: NOT PROTECTED \(the push hook is not in place\)/);
  assert.equal(lastLine(before.stdout), 'To put the hook in place: gotreceipts install');

  assert.equal(runCli(repo, ['install']).status, 0);
  const after = runCli(repo, ['doctor']);
  assert.equal(after.status, 0);
  assert.equal(lastLine(after.stdout), 'VERDICT: PASS (the push hook is in place)');
});

test('doctor changes nothing', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['doctor']);
  assert.equal(existsSync(hookPath(repo)), false);
});

test('doctor names a hook of another origin as not installed', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeForeignHook(repo, 'echo "not yours"');
  const result = runCli(repo, ['doctor']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NOT INSTALLED: another pre-push hook is there, and it was not written by gotreceipts/);
});

test('when the tool has moved away, doctor says the hook is broken and the hook blocks the push', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(runCli(repo, ['gate']).status, 0);

  // The same as moving or deleting the tool after the hook was installed.
  const moved = readFileSync(hookPath(repo), 'utf8').replace(/^cli='.*'$/m, "cli='/no/such/place/cli.js'");
  writeFileSync(hookPath(repo), moved);

  const doctor = runCli(repo, ['doctor']);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /BROKEN: the hook calls a tool that is no longer there \(\/no\/such\/place\/cli\.js\)/);
  assert.match(doctor.stdout, /This clone stops:\n {2}- Every "git push", because the hook cannot find its tool\./);

  const push = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.notEqual(push.status, 0, 'a hook that cannot check must block, even with a valid record');
  assert.match(push.stderr, /CANNOT CHECK: the tool is no longer at \/no\/such\/place\/cli\.js/);
  assert.equal(remoteHas(remote, 'feature/thing'), false);

  // Installing again repairs it.
  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(gitIn(repo, 'push', 'origin', 'feature/thing').status, 0);
});
