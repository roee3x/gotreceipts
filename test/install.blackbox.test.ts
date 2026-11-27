// Outside-in tests for "gotreceipts install", "uninstall" and "doctor".

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  addRemote,
  cliPath,
  gitIn,
  lastLine,
  looseFiles,
  noPersonalGitSettings,
  remoteHas,
  runCli,
  tempFolder,
  tempRepo,
  writeIn,
} from './helpers/temp-repo.ts';

const POLICY = {
  schema: 1,
  levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
  tiers: [{ branch: 'feature/*', level: 'G0' }],
};

const ALL_IN_PLACE = 'VERDICT: PASS (the push hook and the Claude Code hook are in place)';
const SETTINGS = '.claude/settings.local.json';

function hookPath(repo: string, name = 'pre-push'): string {
  return join(repo, '.git', 'hooks', name);
}

function settingsPath(repo: string): string {
  return join(repo, '.claude', 'settings.local.json');
}

function readSettings(repo: string): Record<string, any> {
  return JSON.parse(readFileSync(settingsPath(repo), 'utf8')) as Record<string, any>;
}

/** Writes a hook the way a person or another tool would, before this tool arrives. */
function writeForeignHook(repo: string, body: string, name = 'pre-push'): void {
  const path = writeIn(repo, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// --- install: the git hook ---

test('install writes both hooks and reports what is enforced and what is not', (t) => {
  const repo = tempRepo(t, { policy: POLICY });

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^gotreceipts install:$/m);
  assert.match(result.stdout, /git pre-push hook: written/);
  assert.match(result.stdout, /Claude Code hook: written into \.claude\/settings\.local\.json/);
  assert.match(result.stdout, /policy file\s+OK: 1 level, and a level is set for feature\/\*/);
  assert.match(result.stdout, /git pre-push hook\s+INSTALLED/);
  assert.match(result.stdout, /Claude Code hook\s+INSTALLED/);
  assert.match(result.stdout, /This clone stops:\n {2}- "git push" of a commit that has no valid record/);
  assert.match(result.stdout, /- Claude Code running a bare "gh pr merge"/);
  assert.match(result.stdout, /It does not stop:\n {2}- "git push --no-verify" typed by a person/);
  assert.match(result.stdout, /The merge button on GitHub/);
  assert.equal(lastLine(result.stdout), ALL_IN_PLACE);

  assert.match(readFileSync(hookPath(repo), 'utf8'), /^# gotreceipts:managed-hook pre-push$/m);
});

test('installing twice is safe: both are written again and nothing is doubled', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);

  const again = runCli(repo, ['install']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /git pre-push hook: was already there, written again/);
  assert.match(again.stdout, /Claude Code hook: was already in \.claude\/settings\.local\.json, written again/);
  assert.equal(existsSync(hookPath(repo, 'pre-push.local')), false);
  assert.equal(readSettings(repo)['hooks'].PreToolUse.length, 1);
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

test('with two older hooks in the way, the git hook is not written and both are left alone', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeForeignHook(repo, 'echo first');
  writeForeignHook(repo, 'echo second', 'pre-push.local');

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /git pre-push hook: NOT WRITTEN: a pre-push hook that this tool did not write is there, and so is pre-push\.local/);
  assert.equal(lastLine(result.stdout), 'VERDICT: NOT PROTECTED (not in place: the push hook)');
  assert.match(readFileSync(hookPath(repo), 'utf8'), /echo first/);
  assert.match(readFileSync(hookPath(repo, 'pre-push.local'), 'utf8'), /echo second/);
});

test('when git reads hooks from another folder, no git hook is written and the line to add is given', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(gitIn(repo, 'config', 'core.hooksPath', '.shared-hooks').status, 0);

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /git pre-push hook: NOT WRITTEN: git looks for hooks in "\.shared-hooks" \(the setting core\.hooksPath\)/);
  assert.match(result.stdout, /^ +gotreceipts hook pre-push "\$@"$/m);
  assert.equal(existsSync(hookPath(repo)), false);

  const doctor = runCli(repo, ['doctor']);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /NOT INSTALLED: git looks for hooks in "\.shared-hooks"/);
});

test('install needs a policy first, because the git hook would block every push without one', (t) => {
  const repo = tempRepo(t);
  const result = runCli(repo, ['install']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gotreceipts install: CANNOT RUN: no policy file at/);
  assert.equal(existsSync(hookPath(repo)), false);
  assert.equal(existsSync(settingsPath(repo)), false);
});

test('outside a git repository the three commands cannot run', (t) => {
  const folder = tempFolder(t, 'plain');
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
  assert.equal(existsSync(settingsPath(repo)), false, 'asking for help installs nothing');
});

// --- install: the Claude Code hook ---

test('the Claude Code entry calls this tool before every shell command and every file edit of the agent', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);

  assert.deepEqual(readSettings(repo), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: `node "${cliPath.replace(/\\/g, '/')}" hook claude-code`, timeout: 10 }],
        },
      ],
    },
  });
});

test('the settings file holds a path of this machine, so it is kept out of git, and the folder stays clean', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const env = noPersonalGitSettings(t);

  const result = runCli(repo, ['install'], env);
  assert.match(result.stdout, /Claude Code hook: written into \S+\n.*It is now kept out of git through \.git\/info\/exclude/);
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
  assert.equal(looseFiles(repo, env), '');
  // The gate insists on a folder with no loose changes. Installing must not get in its way.
  assert.equal(runCli(repo, ['gate'], env).status, 0);

  const again = runCli(repo, ['install'], env);
  assert.doesNotMatch(again.stdout, /kept out of git/, 'the line is added once');
});

test('when the repository already ignores what install writes, nothing is added to the exclude file', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const env = noPersonalGitSettings(t);
  writeIn(repo, '.gitignore', '.claude/\n');
  gitIn(repo, 'add', '--all');
  gitIn(repo, 'commit', '--quiet', '-m', 'test: ignore the agent folder');

  const result = runCli(repo, ['install'], env);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /kept out of git/);
  assert.doesNotMatch(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /\.claude/);
});

test('whatever else is in the settings file stays exactly as it was, through install and uninstall', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const before = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo someone-else' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    },
  };
  writeIn(repo, SETTINGS, JSON.stringify(before));

  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(runCli(repo, ['install']).status, 0);
  const installed = readSettings(repo);
  assert.deepEqual(installed['permissions'], before.permissions);
  assert.deepEqual(installed['hooks'].Stop, before.hooks.Stop);
  assert.deepEqual(installed['hooks'].PreToolUse[0], before.hooks.PreToolUse[0]);
  assert.equal(installed['hooks'].PreToolUse.length, 2, 'one entry of someone else, one of this tool');

  assert.equal(runCli(repo, ['uninstall']).status, 0);
  assert.deepEqual(readSettings(repo), before);
});

test('a settings file that is not valid JSON is not touched', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeIn(repo, SETTINGS, '{ "permissions": ');

  const install = runCli(repo, ['install']);
  assert.equal(install.status, 1);
  assert.match(install.stdout, /Claude Code hook: NOT WRITTEN: \.claude\/settings\.local\.json could not be read: it is not valid JSON/);
  assert.match(install.stdout, /Claude Code hook\s+UNKNOWN: \.claude\/settings\.local\.json could not be read/);
  assert.equal(lastLine(install.stdout), 'VERDICT: NOT PROTECTED (not in place: the Claude Code hook)');
  assert.equal(readFileSync(settingsPath(repo), 'utf8'), '{ "permissions": ');

  const uninstall = runCli(repo, ['uninstall']);
  assert.equal(uninstall.status, 1);
  assert.match(uninstall.stdout, /Claude Code hook: NOT REMOVED/);
  assert.equal(readFileSync(settingsPath(repo), 'utf8'), '{ "permissions": ');
});

test('a settings file that is committed is not written to', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeIn(repo, SETTINGS, '{}\n');
  // Forced, because some machines ignore this file for every repository.
  assert.equal(gitIn(repo, 'add', '--force', SETTINGS).status, 0);
  assert.equal(gitIn(repo, 'commit', '--quiet', '-m', 'test: someone committed the local settings').status, 0);

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Claude Code hook: NOT WRITTEN: \.claude\/settings\.local\.json is committed in this repository/);
  assert.equal(readFileSync(settingsPath(repo), 'utf8'), '{}\n');
});

// --- uninstall ---

test('uninstall removes both hooks, and a push is no longer checked', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  assert.equal(runCli(repo, ['install']).status, 0);

  const result = runCli(repo, ['uninstall']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /git pre-push hook: removed/);
  assert.match(result.stdout, /Claude Code hook: removed from \.claude\/settings\.local\.json/);
  assert.equal(lastLine(result.stdout), 'From now on, nothing in this clone is checked by this tool.');
  assert.equal(existsSync(hookPath(repo)), false);
  assert.equal(existsSync(settingsPath(repo)), false, 'a settings file that only held this entry is removed');

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
  const nothing = runCli(repo, ['uninstall']);
  assert.match(nothing.stdout, /git pre-push hook: was not installed, nothing to remove/);
  assert.match(nothing.stdout, /Claude Code hook: was not installed, nothing to remove/);

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
  assert.match(before.stdout, /Claude Code hook\s+NOT INSTALLED/);
  assert.match(before.stdout, /This clone stops:\n {2}- Nothing\. No hook of this tool is in place\./);
  assert.match(before.stdout, /VERDICT: NOT PROTECTED \(not in place: the push hook, the Claude Code hook\)/);
  assert.equal(lastLine(before.stdout), 'To put the hooks in place: gotreceipts install');

  assert.equal(runCli(repo, ['install']).status, 0);
  const after = runCli(repo, ['doctor']);
  assert.equal(after.status, 0);
  assert.equal(lastLine(after.stdout), ALL_IN_PLACE);
});

test('doctor says how many files are protected from an edit by the agent', (t) => {
  const plain = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(plain, ['install']).status, 0);
  assert.match(
    runCli(plain, ['doctor']).stdout,
    /- Claude Code changing a protected file with its edit tools, without a question to the user first \(the policy file\)\./,
  );

  const listed = tempRepo(t, { policy: { ...POLICY, protected: ['checks', 'ci/build.yml'] } });
  assert.equal(runCli(listed, ['install']).status, 0);
  const report = runCli(listed, ['doctor']).stdout;
  assert.match(report, /without a question to the user first \(the policy file and 2 more that the policy lists\)\./);
  assert.match(report, /It does not stop:[\s\S]*- A protected file that is changed by a shell command\. The agent hook sees only the edit tools\./);
});

test('an entry written by an older version is named as out of date, and install brings it up to date', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);

  // What version 0.2 wrote: the same entry, called for the shell tools only.
  const settings = readSettings(repo);
  settings['hooks'].PreToolUse[0].matcher = 'Bash|PowerShell';
  writeFileSync(settingsPath(repo), JSON.stringify(settings));

  const before = runCli(repo, ['doctor']);
  assert.equal(before.status, 1);
  assert.match(before.stdout, /Claude Code hook\s+OUT OF DATE: the entry was written by an older version of the tool/);
  assert.match(before.stdout, /it stops the merge commands, and it does not ask about edits of protected files/);
  assert.match(before.stdout, /- Claude Code running a bare "gh pr merge"/, 'what the older entry does stop is still listed');
  assert.doesNotMatch(before.stdout, /- Claude Code changing a protected file/);
  assert.match(before.stdout, /VERDICT: NOT PROTECTED \(not in place: the current Claude Code hook\)/);

  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(readSettings(repo)['hooks'].PreToolUse.length, 1, 'the older entry is replaced, not kept next to the new one');
  const after = runCli(repo, ['doctor']);
  assert.equal(after.status, 0);
  assert.equal(lastLine(after.stdout), ALL_IN_PLACE);
});

test('doctor changes nothing', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  runCli(repo, ['doctor']);
  assert.equal(existsSync(hookPath(repo)), false);
  assert.equal(existsSync(settingsPath(repo)), false);
});

test('doctor names a hook of another origin as not installed', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeForeignHook(repo, 'echo "not yours"');
  const result = runCli(repo, ['doctor']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NOT INSTALLED: another pre-push hook is there, and it was not written by gotreceipts/);
});

test('doctor says which of the two hooks is missing', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);
  rmSync(settingsPath(repo));

  const result = runCli(repo, ['doctor']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /git pre-push hook\s+INSTALLED/);
  assert.match(result.stdout, /Claude Code hook\s+NOT INSTALLED/);
  assert.match(result.stdout, /VERDICT: NOT PROTECTED \(not in place: the Claude Code hook\)/);
});

test('when the tool has moved away, doctor says so, the git hook blocks the push, and install repairs both', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const remote = addRemote(t, repo);
  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(runCli(repo, ['gate']).status, 0);

  // The same as moving or deleting the tool after the hooks were installed.
  const moved = readFileSync(hookPath(repo), 'utf8').replace(/^cli='.*'$/m, "cli='/no/such/place/cli.js'");
  writeFileSync(hookPath(repo), moved);
  const settings = readSettings(repo);
  settings['hooks'].PreToolUse[0].hooks[0].command = 'node "/no/such/place/cli.js" hook claude-code';
  writeFileSync(settingsPath(repo), JSON.stringify(settings));

  const doctor = runCli(repo, ['doctor']);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /BROKEN: the hook calls a tool that is no longer there \(\/no\/such\/place\/cli\.js\)/);
  assert.match(doctor.stdout, /BROKEN: the entry calls a tool that is no longer there \(\/no\/such\/place\/cli\.js\)/);
  assert.match(doctor.stdout, /This clone stops:\n {2}- Every "git push", because the hook cannot find its tool\./);

  const push = gitIn(repo, 'push', 'origin', 'feature/thing');
  assert.notEqual(push.status, 0, 'a git hook that cannot check must block, even with a valid record');
  assert.match(push.stderr, /CANNOT CHECK: the tool is no longer at \/no\/such\/place\/cli\.js/);
  assert.equal(remoteHas(remote, 'feature/thing'), false);

  // Installing again repairs both.
  assert.equal(runCli(repo, ['install']).status, 0);
  assert.equal(runCli(repo, ['doctor']).status, 0);
  assert.equal(gitIn(repo, 'push', 'origin', 'feature/thing').status, 0);
});
