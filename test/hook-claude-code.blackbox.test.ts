// Outside-in tests for the hook Claude Code calls before it runs a shell command.
// The input is the JSON Claude Code sends, as its hooks reference describes it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCli, tempRepo } from './helpers/temp-repo.ts';

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
  for (const input of ['', 'not json', '{}', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'a.txt' } })]) {
    const result = hook(repo, input);
    assert.equal(result.status, 0, input);
    assert.equal(result.stdout, '', input);
    assert.match(result.stderr, /the input holds no shell command, so nothing was checked/, input);
  }
});
