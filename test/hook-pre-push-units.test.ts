// The two pure steps of the pre-push hook: reading what git says, and deciding what needs a record.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePushLines, planPush, type Entering, type PushedRef } from '../src/hook/pre-push.ts';
import type { PolicyChoice } from '../src/policy/committed.ts';
import type { Policy } from '../src/policy/policy.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NONE = '0'.repeat(40);

const POLICY: Policy = {
  schema: 1,
  levels: [
    { name: 'G0', checks: [] },
    { name: 'G1', checks: [] },
  ],
  tiers: [
    { branch: 'main', level: 'G1' },
    { branch: 'feature/*', level: 'G0' },
  ],
  record: { maxAgeHours: 24 },
};

function pushed(remoteRef: string, localSha = A, remoteSha = B): PushedRef {
  return { localRef: 'refs/heads/local', localSha, remoteRef, remoteSha };
}

test('the lines git gives the hook are read into their four parts', () => {
  const parsed = parsePushLines(`refs/heads/feature/x ${A} refs/heads/feature/x ${B}\nrefs/heads/main ${B} refs/heads/main ${NONE}\n`);
  assert.deepEqual(parsed, {
    ok: true,
    refs: [
      { localRef: 'refs/heads/feature/x', localSha: A, remoteRef: 'refs/heads/feature/x', remoteSha: B },
      { localRef: 'refs/heads/main', localSha: B, remoteRef: 'refs/heads/main', remoteSha: NONE },
    ],
  });
});

test('no lines means nothing is pushed, and that is not an error', () => {
  assert.deepEqual(parsePushLines(''), { ok: true, refs: [] });
  assert.deepEqual(parsePushLines('\n\n'), { ok: true, refs: [] });
});

test('Windows line endings are read the same way', () => {
  const parsed = parsePushLines(`refs/heads/main ${A} refs/heads/main ${B}\r\n`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.refs[0]?.remoteSha, B);
});

test('a line of another shape is an error, never a guess', () => {
  for (const line of [
    `refs/heads/main ${A} refs/heads/main`,
    `refs/heads/main ${A} refs/heads/main ${B} extra`,
    `refs/heads/main not-a-commit refs/heads/main ${B}`,
    'hello',
  ]) {
    const parsed = parsePushLines(line);
    assert.equal(parsed.ok, false, line);
    assert.match(parsed.ok ? '' : parsed.error, /does not understand/);
  }
});

/** Stands in for reading the policy off the target branch: every branch that exists holds POLICY. */
function fromTarget(entering: Entering): PolicyChoice {
  return entering.targetCommit === undefined
    ? { ok: true, policy: POLICY, source: { kind: 'own', commit: entering.commit, because: `"${entering.branch}" does not exist yet` } }
    : { ok: true, policy: POLICY, source: { kind: 'target', shown: 'the remote', commit: entering.targetCommit, changedByCommit: false } };
}

test('a commit entering a branch with a level needs a record at that level', () => {
  assert.deepEqual(planPush([pushed('refs/heads/feature/login'), pushed('refs/heads/main')], fromTarget), [
    { kind: 'check', branch: 'feature/login', commit: A, level: 'G0', policy: POLICY, notes: [] },
    { kind: 'check', branch: 'main', commit: A, level: 'G1', policy: POLICY, notes: [] },
  ]);
});

test('the policy is asked for the branch as the remote has it, and for the pushed commit', () => {
  const asked: Entering[] = [];
  planPush([pushed('refs/heads/main', A, B), pushed('refs/heads/feature/new', A, NONE)], (entering) => {
    asked.push(entering);
    return fromTarget(entering);
  });
  assert.deepEqual(asked, [
    { branch: 'main', commit: A, targetCommit: B },
    { branch: 'feature/new', commit: A, targetCommit: undefined },
  ]);
});

test('a brand-new branch is checked like any other, and the output says whose policy was used', () => {
  assert.deepEqual(planPush([pushed('refs/heads/main', A, NONE)], fromTarget), [
    {
      kind: 'check',
      branch: 'main',
      commit: A,
      level: 'G1',
      policy: POLICY,
      notes: ['policy: the one in this commit, because "main" does not exist yet'],
    },
  ]);
});

test('a commit that changes the policy is told that the change does not count', () => {
  const step = planPush([pushed('refs/heads/main')], (entering) => ({
    ok: true,
    policy: POLICY,
    source: { kind: 'target', shown: '"main" on the remote', commit: entering.targetCommit ?? '', changedByCommit: true },
  }))[0];
  assert.equal(step?.kind, 'check');
  assert.deepEqual(step?.kind === 'check' ? step.notes : [], [
    'this commit changes the policy file. It is judged by the policy that is already on "main" on the remote',
  ]);
});

test('a policy that cannot be read is an error for that branch, never a skip', () => {
  assert.deepEqual(
    planPush([pushed('refs/heads/main')], () => ({ ok: false, errors: ['the policy is not valid'] })),
    [{ kind: 'error', name: 'main', errors: ['the policy is not valid'] }],
  );
});

test('a branch the policy sets no level for is not checked', () => {
  assert.deepEqual(planPush([pushed('refs/heads/notes')], fromTarget), [
    { kind: 'skip', name: 'notes', reason: 'the policy sets no level for this branch' },
  ]);
});

test('a tag is not checked, even when its name looks like a guarded branch', () => {
  assert.deepEqual(planPush([pushed('refs/tags/main')], fromTarget), [
    { kind: 'skip', name: 'refs/tags/main', reason: 'not a branch' },
  ]);
});

test('deleting a branch is not checked: no commit enters it, and no policy is read', () => {
  const step = planPush([pushed('refs/heads/main', NONE, A)], () => {
    throw new Error('the policy must not be asked for');
  })[0];
  assert.equal(step?.kind, 'skip');
  assert.match(step?.kind === 'skip' ? step.reason : '', /being deleted/);
});
