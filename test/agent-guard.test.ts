// Which shell commands the agent hook stops, and which it lets through.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forbiddenCommand, guardMessage, splitCommands } from '../src/agent/guard.ts';

test('a shell line is split into commands and words, with quotes kept together', () => {
  assert.deepEqual(splitCommands('git status'), [['git', 'status']]);
  assert.deepEqual(splitCommands('git commit -m "one two" && git push'), [
    ['git', 'commit', '-m', 'one two'],
    ['git', 'push'],
  ]);
  assert.deepEqual(splitCommands("echo 'a; b' ; ls | wc -l"), [['echo', 'a; b'], ['ls'], ['wc', '-l']]);
  assert.deepEqual(splitCommands('first\nsecond line'), [['first'], ['second', 'line']]);
  assert.deepEqual(splitCommands('echo $(date) `whoami`'), [['echo'], ['date'], ['whoami']]);
  assert.deepEqual(splitCommands('& "C:\\Program Files\\GitHub CLI\\gh.exe" pr list'), [
    ['C:\\Program Files\\GitHub CLI\\gh.exe', 'pr', 'list'],
  ]);
  assert.deepEqual(splitCommands('one \\\n two'), [['one', 'two']]);
  assert.deepEqual(splitCommands(''), []);
});

const MERGES = [
  'gh pr merge 5',
  'gh pr merge 5 --merge --delete-branch',
  'gh pr merge',
  'gh.exe pr merge 5',
  '"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 12 --squash',
  '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 12',
  '/usr/local/bin/gh pr merge 5',
  'gh -R owner/repo pr merge 5',
  'gh --repo owner/repo pr merge 5',
  'gh pr -R owner/repo merge 5',
  'cd project && gh pr merge 5',
  'git status; gh pr merge 5',
  'GH_TOKEN=abc gh pr merge 5',
  'echo y | gh pr merge 5',
  'gh pr checks 5 --watch && gh pr merge 5 --merge',
  'bash -c "gh pr merge 5"',
  'sh -c \'cd x && gh pr merge 5\'',
  'powershell -Command "gh pr merge 5"',
  'pwsh -c "gh pr merge 5"',
  'cmd /c gh pr merge 5',
  'result=$(gh pr merge 5)',
  'echo `gh pr merge 5`',
  'gh pr\\\n  merge 5',
];

test('a bare "gh pr merge" is stopped, however it is written', () => {
  for (const line of MERGES) {
    assert.equal(forbiddenCommand(line), 'gh-pr-merge', line);
  }
});

test('the same merge asked for through "gh api" is stopped', () => {
  for (const line of [
    'gh api -X PUT repos/owner/repo/pulls/5/merge',
    'gh api repos/owner/repo/pulls/5/merge --method PUT -f merge_method=merge',
    'gh api --method=put /repos/owner/repo/pulls/5/merge',
    'gh api -XPUT repos/owner/repo/pulls/5/merge',
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  ]) {
    assert.equal(forbiddenCommand(line), 'gh-api-merge', line);
  }
});

test('"git push --no-verify" is stopped', () => {
  for (const line of [
    'git push --no-verify',
    'git push origin main --no-verify',
    'git push --no-verify origin feature/x',
    'git -C sub/folder push --no-verify',
    'git -c core.sshCommand=ssh push origin x --no-verify',
    'npm test && git push --no-verify',
    'git.exe push --no-verify',
  ]) {
    assert.equal(forbiddenCommand(line), 'push-no-verify', line);
  }
});

test('everything else is let through', () => {
  for (const line of [
    '',
    'npm test',
    'gh pr view 5',
    'gh pr view 5 --json mergeable,mergeStateStatus',
    'gh pr list --search merge',
    'gh pr checks 5 --watch',
    'gh pr create --title "merge the things" --body "see gh pr merge"',
    'gh api repos/owner/repo/pulls/5/merge',
    'gh api repos/owner/repo/pulls/5',
    'gh run list --branch merge',
    'git push',
    'git push origin feature/x',
    'git push --force-with-lease',
    'git merge feature/x',
    'git commit --no-verify -m "wip"',
    'git commit -m "gh pr merge is not allowed here"',
    'git log --grep "push --no-verify"',
    'echo "git push --no-verify"',
    'grep -r "pr merge" docs/',
    'gotreceipts merge 5',
    'node dist/cli.js merge 5',
    'gotreceipts gate --for main',
  ]) {
    assert.equal(forbiddenCommand(line), undefined, line);
  }
});

test('"gotreceipts approve" is stopped: an approval is a person\'s signature', () => {
  for (const line of [
    'gotreceipts approve --for main',
    'gotreceipts approve abc1234 --for main --key ~/.ssh/some_key',
    'gotreceipts approve --pr 12',
    'npx gotreceipts approve --for main',
    'npx gotreceipts@0.3.0 approve --for main',
    'node "C:/tools/gotreceipts/dist/cli.js" approve --for main',
    'node dist/cli.js approve --for main',
    'echo approve | gotreceipts approve --for main',
    'git status && gotreceipts.cmd approve --for main',
    'bash -c "gotreceipts approve --for main"',
  ]) {
    assert.equal(forbiddenCommand(line), 'approve', line);
  }
});

test('reading about "approve" is not stopped, and neither is the word in another place', () => {
  for (const line of [
    'gotreceipts approve --help',
    'gotreceipts approve -h',
    'gotreceipts verify --for main',
    'gotreceipts gate --for approve',
    'git commit -m "docs: how to approve"',
    'node scripts/approve.js',
    'grep -r approve src',
  ]) {
    assert.equal(forbiddenCommand(line), undefined, line);
  }

  const message = guardMessage('approve', 'node "/opt/tool/cli.js"');
  assert.match(message, /an approval is the signature of an owner of this repository/);
  assert.match(message, /They run the command in their own terminal/);
  assert.match(message, /do not make or use a key for it/);
});

test('when in doubt it stops: the words of a merge outside quotes are enough', () => {
  // Nothing would be merged here. The hook cannot know that, and a refusal with a clear message costs little.
  assert.equal(forbiddenCommand('echo gh pr merge 5'), 'gh-pr-merge');
});

test('the message names the command to use instead, and how to start the tool', () => {
  const merge = guardMessage('gh-pr-merge', 'node "/opt/tool/cli.js"');
  assert.match(merge, /Run "gotreceipts merge <pull request number>" instead/);
  assert.match(merge, /Do not look for another way to merge/);
  assert.match(merge, /start it as: node "\/opt\/tool\/cli\.js"$/);
  assert.equal(guardMessage('gh-api-merge', 'x'), guardMessage('gh-pr-merge', 'x'));

  const push = guardMessage('push-no-verify', 'node "/opt/tool/cli.js"');
  assert.match(push, /Push without that option/);
  assert.match(push, /run "gotreceipts gate" to make one/);
});
