// Outside-in tests for the hook Claude Code calls before it runs a shell command or changes a file.
// The input is the JSON Claude Code sends, as its hooks reference describes it.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

/** What Claude Code sends before a shell command, with the fields its reference lists. */
function call(command: string, tool = 'Bash'): string {
  return JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/somewhere/transcript.jsonl',
    cwd: '/somewhere/project',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command, description: 'a test call', timeout: 120000, run_in_background: false },
    tool_use_id: 'toolu_01',
  });
}

function hook(repo: string, input: string) {
  return runCli(repo, ['hook', 'claude-code'], {}, input);
}

test('a bare "gh pr merge" is denied, and the agent is told what to run instead', (t) => {
  const repo = tempRepo(t);
  const result = hook(repo, call('gh pr merge 12 --merge'));
  assert.equal(result.status, 0, result.stderr);

  const answer = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
  assert.equal(answer.hookSpecificOutput['hookEventName'], 'PreToolUse');
  assert.equal(answer.hookSpecificOutput['permissionDecision'], 'deny');
  assert.match(answer.hookSpecificOutput['permissionDecisionReason'] ?? '', /Run "gotreceipts merge <pull request number>" instead/);
  assert.match(answer.hookSpecificOutput['permissionDecisionReason'] ?? '', /start it as: node ".*cli\.js"$/);
});

test('the same holds for the PowerShell tool', (t) => {
  const repo = tempRepo(t);
  const result = hook(repo, call('gh pr merge 12; Write-Host done', 'PowerShell'));
  assert.equal((JSON.parse(result.stdout) as any).hookSpecificOutput.permissionDecision, 'deny');
});

test('"git push --no-verify" is denied with its own advice', (t) => {
  const repo = tempRepo(t);
  const result = hook(repo, call('git push --no-verify origin main'));
  const reason = (JSON.parse(result.stdout) as any).hookSpecificOutput.permissionDecisionReason as string;
  assert.match(reason, /"git push --no-verify" skips the check that runs before a push/);
  assert.match(reason, /Push without that option/);
});

test('any other command gets no answer at all, so Claude Code goes on as it would have', (t) => {
  const repo = tempRepo(t);
  for (const command of ['npm test', 'git push origin feature/x', 'gh pr view 12', 'gotreceipts merge 12']) {
    const result = hook(repo, call(command));
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
  }
});

test('input it cannot read is let through, with a note: this hook is early feedback, not the checkpoint', (t) => {
  const repo = tempRepo(t);
  for (const input of ['', 'not json', '{}', '[]', JSON.stringify({ tool_name: 'Read', tool_input: { pattern: '*.ts' } })]) {
    const result = hook(repo, input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, '', input);
    assert.match(result.stderr, /the input holds no shell command and no file, so nothing was checked/, input);
  }
});

// --- edits of protected files ---

const POLICY = {
  schema: 1,
  levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
  tiers: [{ branch: 'feature/*', level: 'G0' }],
  protected: ['checks', 'ci/*.yml'],
};

/** What Claude Code sends before it changes a file. `cwd` is the folder the session works in. */
function edit(cwd: string, file: string, tool = 'Edit', field = 'file_path'): string {
  return JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/somewhere/transcript.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { [field]: file, old_string: 'a', new_string: 'b' },
    tool_use_id: 'toolu_02',
  });
}

function decision(stdout: string): Record<string, string> {
  return (JSON.parse(stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
}

test('an edit of the policy file is put to the user, with the reason', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const result = hook(repo, edit(repo, join(repo, 'gotreceipts.json')));
  assert.equal(result.status, 0, result.stderr);

  const answer = decision(result.stdout);
  assert.equal(answer['hookEventName'], 'PreToolUse');
  assert.equal(answer['permissionDecision'], 'ask', 'the person decides, so it is a question and not a refusal');
  assert.match(answer['permissionDecisionReason'] ?? '', /^GotReceipts: "gotreceipts\.json" is a protected file\./);
  assert.match(answer['permissionDecisionReason'] ?? '', /Allow this edit only if you want the gate itself changed\.$/);
});

test('the same holds for every tool that changes a file, and for every file the policy lists', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const calls: [string, string][] = [
    [edit(repo, join(repo, 'gotreceipts.json'), 'Write'), 'gotreceipts.json'],
    [edit(repo, join(repo, 'gotreceipts.json'), 'MultiEdit'), 'gotreceipts.json'],
    [edit(repo, join(repo, 'checks', 'pass.js')), 'checks/pass.js'],
    [edit(repo, join(repo, 'checks', 'new', 'one.js'), 'Write'), 'checks/new/one.js'],
    [edit(repo, join(repo, 'ci', 'build.yml'), 'Write'), 'ci/build.yml'],
    [edit(repo, join(repo, 'ci', 'notes.yml'), 'NotebookEdit', 'notebook_path'), 'ci/notes.yml'],
  ];
  for (const [input, path] of calls) {
    const result = hook(repo, input);
    assert.equal(decision(result.stdout)['permissionDecision'], 'ask', path);
    assert.ok((decision(result.stdout)['permissionDecisionReason'] ?? '').includes(`"${path}" is a protected file`), path);
  }
});

test('a path is read the way the agent wrote it: relative, from a folder below, or in other letters', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const below = join(repo, 'checks');
  for (const input of [
    edit(repo, 'gotreceipts.json'),
    edit(repo, './checks/pass.js'),
    edit(below, '../gotreceipts.json'),
    edit(below, 'pass.js'),
    edit(repo, join(repo, 'GotReceipts.JSON')),
    edit(repo, join(repo, 'gotreceipts.json').replace(/\\/g, '/')),
    // A session that was started in a folder above the repository.
    edit(tmpdir(), join(repo, 'gotreceipts.json')),
  ]) {
    assert.equal(decision(hook(repo, input).stdout)['permissionDecision'], 'ask', input);
  }
});

test('an edit of any other file gets no answer at all', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  for (const input of [
    edit(repo, join(repo, 'data.txt')),
    edit(repo, join(repo, 'src', 'new.ts'), 'Write'),
    edit(repo, join(repo, 'ci', 'readme.md')),
    edit(repo, join(repo, 'notes', 'gotreceipts.json')),
    // A file outside the repository is not this gate's business.
    edit(repo, join(repo, '..', 'gotreceipts.json')),
    edit(repo, ''),
  ]) {
    const result = hook(repo, input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, '', input);
  }
});

test('a protected file reached through a link is still protected', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  try {
    // A folder link. On Windows a "junction" needs no special right.
    symlinkSync(join(repo, 'checks'), join(repo, 'other-name'), 'junction');
  } catch {
    t.skip('this machine does not allow links to be made');
    return;
  }
  const result = hook(repo, edit(repo, join(repo, 'other-name', 'pass.js')));
  assert.equal(decision(result.stdout)['permissionDecision'], 'ask');
  assert.match(decision(result.stdout)['permissionDecisionReason'] ?? '', /"checks\/pass\.js" is a protected file/);
});

test('the list that counts is the committed one: taking a file off the list in the folder does not unprotect it', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  writeIn(repo, 'gotreceipts.json', `${JSON.stringify({ ...POLICY, protected: [] })}\n`);

  assert.equal(decision(hook(repo, edit(repo, join(repo, 'checks', 'pass.js'))).stdout)['permissionDecision'], 'ask');
});

test('a repository with no committed policy has nothing to protect yet, so its first policy is written freely', (t) => {
  const repo = tempRepo(t);
  const result = hook(repo, edit(repo, join(repo, 'gotreceipts.json'), 'Write'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');

  const empty = tempRepo(t, { policy: POLICY, commit: false });
  assert.equal(hook(empty, edit(empty, join(empty, 'gotreceipts.json'), 'Write')).stdout, '');
});

test('when the hook cannot find the repository, the edit is let through: it fails open', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const outside = mkdtempSync(join(tmpdir(), 'gotreceipts-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  for (const input of [edit(outside, 'gotreceipts.json'), edit(join(outside, 'no-such-folder'), 'gotreceipts.json')]) {
    const result = hook(repo, input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, '', input);
  }
});
