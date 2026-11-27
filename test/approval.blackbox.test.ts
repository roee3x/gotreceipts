// Outside-in tests for the signed approval: the "approve" command, and the question every door
// asks, "does this commit have a valid approval for this branch?".
//
// The keys are made for each test, have no passphrase, and are removed with the test.

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { checkSignature } from '../src/approval/ssh.ts';
import { approvalText, newApproval } from '../src/approval/statement.ts';
import { addRemote, gitIn, lastLine, plantApproval, runCli, tempRepo, testKey, writeIn, type TestKey } from './helpers/temp-repo.ts';

/**
 * main asks for an approval of every commit. develop does not. The folder of the checks is
 * protected. One signer, "owner".
 */
function policyFor(owner: TestKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'develop', level: 'G0' },
      { branch: 'main', level: 'G0', needsApproval: true },
    ],
    protected: ['checks'],
    approval: { signers: [{ name: 'owner', key: owner.publicKey }] },
    ...extra,
  };
}

interface Scene {
  readonly repo: string;
  readonly owner: TestKey;
  /** The commit main and develop point to on the remote. */
  readonly base: string;
}

function head(repo: string): string {
  return gitIn(repo, 'rev-parse', 'HEAD').stdout.trim();
}

/** A repository on feature/thing, and a remote whose main and develop hold the policy. */
function scene(t: TestContext, makePolicy: (owner: TestKey) => unknown = policyFor): Scene {
  const owner = testKey(t);
  const repo = tempRepo(t, { policy: makePolicy(owner) });
  addRemote(t, repo);
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', 'feature/thing:main', 'feature/thing:develop').status, 0);
  assert.equal(gitIn(repo, 'fetch', '--quiet', 'origin').status, 0);
  return { repo, owner, base: head(repo) };
}

/** Commits one changed file on the branch that is checked out, gates the commit, and returns it. */
function gatedCommit(repo: string, path = 'data.txt', content = 'changed\n'): string {
  writeIn(repo, path, content);
  assert.equal(gitIn(repo, 'add', '--all').status, 0);
  assert.equal(gitIn(repo, 'commit', '--quiet', '-m', `test: change ${path}`).status, 0);
  const gate = runCli(repo, ['gate', '--level', 'G0']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  return head(repo);
}

/** Runs "approve" the way a person would: the command, and then the word on the keyboard. */
function approve(repo: string, key: TestKey, args: string[], typed = 'approve\n') {
  return runCli(repo, ['approve', ...args, '--key', key.file], {}, typed);
}

/** Calls the push hook the way git does, for "push this commit to this branch, which is at `remoteCommit`". */
function push(repo: string, commit: string, branch: string, remoteCommit: string) {
  const line = `refs/heads/feature/thing ${commit} refs/heads/${branch} ${remoteCommit}\n`;
  return runCli(repo, ['hook', 'pre-push', 'origin', 'https://example.com/repo.git'], {}, line);
}

function approvalFile(repo: string, commit: string, branch: string): string {
  return join(repo, '.git', 'gotreceipts', 'approvals', commit, `${encodeURIComponent(branch)}.json`);
}

// --- the central claim ---

test('a branch that asks for an approval refuses a commit that has only its record', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  const short = commit.slice(0, 7);

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 1, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /G0 record, passed 0\.0 hours ago, under the current policy/);
  assert.match(verify.stdout, /approval: needed, because every commit that enters "main" needs one/);
  assert.match(verify.stdout, /there is no approval of this commit for "main"/);
  assert.match(verify.stdout, new RegExp(`VERDICT: REFUSED \\(commit ${short} has its record, and no valid approval for "main"\\)`));
  assert.match(verify.stdout, /An approval is the signature of an owner\. They give it in their own terminal:/);
  assert.equal(lastLine(verify.stdout), `  gotreceipts approve ${short} --for main`);

  const pushed = push(s.repo, commit, 'main', s.base);
  assert.equal(pushed.status, 1, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /main: commit \w{7} needs level G0: PASS/);
  assert.match(pushed.stdout, /there is no approval of this commit for "main"/);
  assert.match(pushed.stdout, /VERDICT: REFUSED \(the pushed commit has no valid approval\)\. Nothing was pushed\./);
  assert.equal(lastLine(pushed.stdout), `  gotreceipts approve ${short} --for main`);

  // The same commit into a branch that asks for no approval gets in on its record alone.
  const develop = runCli(s.repo, ['verify', '--for', 'develop']);
  assert.equal(develop.status, 0, develop.stdout);
  assert.doesNotMatch(develop.stdout, /approval/);
});

test('the owner signs, and the same commit gets in', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  const short = commit.slice(0, 7);

  const approved = approve(s.repo, s.owner, ['--for', 'main']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  // What is about to be approved is shown before the word is asked for.
  const [shown = '', after = ''] = approved.stdout.split('Type "approve" and press Enter to sign this.');
  assert.match(shown, new RegExp(`gotreceipts approve: commit ${short} into "main"`));
  assert.match(shown, new RegExp(`commit: ${short} test: change data\\.txt`));
  assert.match(shown, new RegExp(`policy: the one on origin/main, at commit ${s.base.slice(0, 7)}`));
  assert.match(shown, /record: G0 record, passed 0\.0 hours ago, under the current policy/);
  assert.match(shown, /approval: needed, because every commit that enters "main" needs one/);
  assert.match(shown, /changes: 1 file is not the same as on origin\/main\n {4}data\.txt\n/);
  assert.match(shown, /signers the policy lists: owner/);
  assert.match(after, /signed by owner/);
  assert.match(after, new RegExp(`kept as \\.git/gotreceipts/approvals/${commit}/main\\.json`));
  assert.match(after, /it counts for 24 hours, for this commit and this branch only/);
  assert.equal(lastLine(approved.stdout), `VERDICT: APPROVED (commit ${short} into "main", by owner)`);

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /approved by owner, 0\.0 hours ago/);
  assert.equal(lastLine(verify.stdout), `VERDICT: PASS (commit ${short} satisfies level G0, and is approved for "main")`);

  const pushed = push(s.repo, commit, 'main', s.base);
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
  assert.match(pushed.stdout, /approved by owner, 0\.0 hours ago/);
});

test('the approval is a small file that names the commit and the branch, and nothing of the machine', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  assert.equal(approve(s.repo, s.owner, ['--for', 'main']).status, 0);

  const text = readFileSync(approvalFile(s.repo, commit, 'main'), 'utf8');
  const approval = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(approval), ['schema', 'kind', 'tool', 'commit', 'branch', 'approvedAt']);
  assert.equal(approval['kind'], 'approval');
  assert.equal(approval['commit'], commit);
  assert.equal(approval['branch'], 'main');
  assert.match(String(approval['approvedAt']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.doesNotMatch(text, /gotreceipts-test-|gotreceipts-key-/, 'no folder of this machine');
  assert.match(readFileSync(`${approvalFile(s.repo, commit, 'main')}.sig`, 'utf8'), /^-----BEGIN SSH SIGNATURE-----/);
});

test('anything but the whole word stops before signing', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);

  for (const typed of ['yes\n', 'y\n', 'APPROVE\n', '\n', '']) {
    const result = approve(s.repo, s.owner, ['--for', 'main'], typed);
    assert.equal(result.status, 1, JSON.stringify(typed));
    assert.equal(lastLine(result.stdout), 'VERDICT: NOT APPROVED (stopped before signing. Nothing was signed)', JSON.stringify(typed));
  }
  assert.equal(existsSync(approvalFile(s.repo, commit, 'main')), false);
  assert.equal(runCli(s.repo, ['verify', '--for', 'main']).status, 1);
});

// --- one use ---

test('an approval is for one commit: the next commit needs its own', (t) => {
  const s = scene(t);
  gatedCommit(s.repo);
  assert.equal(approve(s.repo, s.owner, ['--for', 'main']).status, 0);
  assert.equal(runCli(s.repo, ['verify', '--for', 'main']).status, 0);

  gatedCommit(s.repo, 'data.txt', 'changed again\n');
  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /there is no approval of this commit for "main"/);
});

test('an approval is for one branch, and copying it under the name of another does not help', (t) => {
  const s = scene(t, (owner) => {
    const policy = policyFor(owner);
    (policy['tiers'] as Record<string, unknown>[])[1]!['needsApproval'] = true;
    return policy;
  });
  const commit = gatedCommit(s.repo);
  assert.equal(approve(s.repo, s.owner, ['--for', 'main']).status, 0);

  const other = runCli(s.repo, ['verify', '--for', 'develop']);
  assert.equal(other.status, 1);
  assert.match(other.stdout, /there is no approval of this commit for "develop"/);

  copyFileSync(approvalFile(s.repo, commit, 'main'), approvalFile(s.repo, commit, 'develop'));
  copyFileSync(`${approvalFile(s.repo, commit, 'main')}.sig`, `${approvalFile(s.repo, commit, 'develop')}.sig`);
  const copied = runCli(s.repo, ['verify', '--for', 'develop']);
  assert.equal(copied.status, 1);
  assert.match(copied.stdout, /the approval that is there does not count: it approves another branch/);

  // And the same for another commit.
  const next = gatedCommit(s.repo, 'data.txt', 'changed again\n');
  writeIn(s.repo, `.git/gotreceipts/approvals/${next}/main.json`, readFileSync(approvalFile(s.repo, commit, 'main'), 'utf8'));
  copyFileSync(`${approvalFile(s.repo, commit, 'main')}.sig`, `${approvalFile(s.repo, next, 'main')}.sig`);
  assert.match(runCli(s.repo, ['verify', '--for', 'main']).stdout, /the approval that is there does not count: it approves another commit/);
});

// --- it cannot be made up ---

test('an approval that was changed after signing does not count', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  assert.equal(approve(s.repo, s.owner, ['--for', 'main']).status, 0);

  const file = approvalFile(s.repo, commit, 'main');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"branch": "main"', '"branch":  "main"'));

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /the approval that is there does not count: its signature does not fit its text/);
});

test('a signature by a key the policy does not list does not count, and "approve" says so at once', (t) => {
  const s = scene(t);
  const stranger = testKey(t);
  const commit = gatedCommit(s.repo);

  const result = approve(s.repo, stranger, ['--for', 'main']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /VERDICT: NOT APPROVED \(the key that signed is not one the policy lists, so the signature would not count\)/);
  assert.equal(lastLine(result.stdout), 'Its public half must be listed under approval.signers in gotreceipts.json, on "main" itself.');
  assert.equal(existsSync(approvalFile(s.repo, commit, 'main')), false, 'nothing is kept');

  // Made by hand and put in place, it is turned away at the door.
  plantApproval(t, s.repo, { commit, branch: 'main' }, approvalText(newApproval(commit, 'main', '0.0.0', Date.now())), stranger);
  const pushed = push(s.repo, commit, 'main', s.base);
  assert.equal(pushed.status, 1);
  assert.match(pushed.stdout, /the approval that is there does not count: it was not signed by a key the policy lists/);
});

test('a commit cannot name its own signer: the keys that count are the ones on the target branch', (t) => {
  const s = scene(t);
  const stranger = testKey(t);
  // The commit adds a second signer to its own copy of the policy, and signs with that key.
  const widened = policyFor(s.owner, {
    approval: { signers: [{ name: 'owner', key: s.owner.publicKey }, { name: 'helper', key: stranger.publicKey }] },
  });
  const commit = gatedCommit(s.repo, 'gotreceipts.json', `${JSON.stringify(widened, null, 2)}\n`);

  const result = approve(s.repo, stranger, ['--for', 'main']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /signers the policy lists: owner\n/);
  assert.match(result.stdout, /VERDICT: NOT APPROVED \(the key that signed is not one the policy lists/);

  plantApproval(t, s.repo, { commit, branch: 'main' }, approvalText(newApproval(commit, 'main', '0.0.0', Date.now())), stranger);
  assert.equal(push(s.repo, commit, 'main', s.base).status, 1);

  // What lets the new signer in is the owner's signature, and a record made under the policy of main.
  assert.equal(approve(s.repo, s.owner, ['--for', 'main']).status, 0);
  const stillNoRecord = push(s.repo, commit, 'main', s.base);
  assert.equal(stillNoRecord.status, 1);
  assert.match(stillNoRecord.stdout, /VERDICT: REFUSED \(the pushed commit has no valid record\)/);
  assert.equal(runCli(s.repo, ['gate', '--for', 'main']).status, 0);
  assert.equal(push(s.repo, commit, 'main', s.base).status, 0);
});

test('a signature that was made for another purpose is not an approval', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  const text = approvalText(newApproval(commit, 'main', '0.0.0', Date.now()));
  // The same key, the same text, signed the way git signs a commit.
  plantApproval(t, s.repo, { commit, branch: 'main' }, text, s.owner, 'git');

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /the approval that is there does not count/);
});

test('an approval gets old, and one from the future is not believed', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  const hour = 3_600_000;

  plantApproval(t, s.repo, { commit, branch: 'main' }, approvalText(newApproval(commit, 'main', '0.0.0', Date.now() - 25 * hour)), s.owner);
  assert.match(runCli(s.repo, ['verify', '--for', 'main']).stdout, /does not count: it is older than the 24 hours an approval counts for/);

  plantApproval(t, s.repo, { commit, branch: 'main' }, approvalText(newApproval(commit, 'main', '0.0.0', Date.now() + hour)), s.owner);
  assert.match(runCli(s.repo, ['verify', '--for', 'main']).stdout, /does not count: it is dated in the future/);

  plantApproval(t, s.repo, { commit, branch: 'main' }, approvalText(newApproval(commit, 'main', '0.0.0', Date.now() - 23 * hour)), s.owner);
  const fresh = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.match(fresh.stdout, /approved by owner, 23\.0 hours ago/);
});

test('the policy says for how long an approval counts', (t) => {
  const s = scene(t, (owner) => policyFor(owner, { approval: { signers: [{ name: 'owner', key: owner.publicKey }], maxAgeHours: 2 } }));
  const commit = gatedCommit(s.repo);
  plantApproval(t, s.repo, { commit, branch: 'main' }, approvalText(newApproval(commit, 'main', '0.0.0', Date.now() - 3 * 3_600_000)), s.owner);
  assert.match(runCli(s.repo, ['verify', '--for', 'main']).stdout, /it is older than the 2 hours an approval counts for/);
});

test('a signed text that is not an approval does not count', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  const good = newApproval(commit, 'main', '0.0.0', Date.now());

  const wrong: [string, RegExp][] = [
    ['hello', /it is not valid JSON/],
    [JSON.stringify({ ...good, note: 'and everything after it' }), /it holds an unknown entry, "note"/],
    [JSON.stringify({ ...good, kind: 'record' }), /it is not an approval/],
    [JSON.stringify({ ...good, commit: commit.slice(0, 7) }), /it does not name a commit by its full id/],
    [JSON.stringify({ ...good, approvedAt: 'yesterday' }), /it does not say when it was given/],
  ];
  for (const [text, expected] of wrong) {
    plantApproval(t, s.repo, { commit, branch: 'main' }, text, s.owner);
    const verify = runCli(s.repo, ['verify', '--for', 'main']);
    assert.equal(verify.status, 1, text);
    assert.match(verify.stdout, expected, text);
  }
});

// --- protected files ---

test('a change to a protected file needs an approval on every branch with a level', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo, 'checks/extra.js', 'process.exit(0);\n');
  const short = commit.slice(0, 7);

  // develop asks for no approval of ordinary commits. This one changes a protected file.
  const verify = runCli(s.repo, ['verify', '--for', 'develop']);
  assert.equal(verify.status, 1, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /1 protected file is not the same as on origin\/develop: checks\/extra\.js/);
  assert.match(verify.stdout, /approval: needed, because it would change a protected file/);
  assert.equal(lastLine(verify.stdout), `  gotreceipts approve ${short} --for develop`);
  assert.equal(push(s.repo, commit, 'develop', s.base).status, 1);

  // Into main, both reasons are named.
  assert.match(
    runCli(s.repo, ['verify', '--for', 'main']).stdout,
    /approval: needed, because every commit that enters "main" needs one, and it would change a protected file/,
  );

  const approved = approve(s.repo, s.owner, ['--for', 'develop']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /changes: 1 file is not the same as on origin\/develop\n {4}\[protected\] checks\/extra\.js\n/);
  assert.equal(push(s.repo, commit, 'develop', s.base).status, 0);
});

test('the gate says early that the commit will need an approval, and still gives its own verdict', (t) => {
  const s = scene(t);
  writeIn(s.repo, 'checks/extra.js', 'process.exit(0);\n');
  assert.equal(gitIn(s.repo, 'add', '--all').status, 0);
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '-m', 'test: a new check').status, 0);

  const gate = runCli(s.repo, ['gate', '--for', 'develop']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.match(gate.stdout, /\n {8}approval: needed, because it would change a protected file\n {8}there is no approval of this commit for "develop"\n/);
  assert.match(lastLine(gate.stdout), /^VERDICT: PASS \(level G0, /);
});

test('with no signer in the policy the lock is open, and every command says so', (t) => {
  const s = scene(t, () => ({
    schema: 1,
    levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'develop', level: 'G0' },
      { branch: 'main', level: 'G0' },
    ],
    protected: ['checks'],
  }));
  const commit = gatedCommit(s.repo, 'checks/extra.js', 'process.exit(0);\n');

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 0, verify.stdout);
  assert.match(verify.stdout, /approval: not asked for\. The policy lists no signer, so a change to a protected file needs nobody's signature/);
  assert.equal(push(s.repo, commit, 'main', s.base).status, 0);

  const result = approve(s.repo, s.owner, ['--for', 'main']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CANNOT RUN: the policy \(the one on origin\/main, at commit \w{7}\) lists no signer/);

  assert.match(runCli(s.repo, ['policy']).stdout, /Approval: NOT LOCKED\. The policy lists no signer/);
  assert.match(runCli(s.repo, ['doctor']).stdout, /approval\s+NOT LOCKED: the policy lists no signer/);
});

test('"policy" and "doctor" say who may sign and what asks for a signature', (t) => {
  const s = scene(t);

  const policy = runCli(s.repo, ['policy']);
  assert.equal(policy.status, 0, policy.stderr);
  assert.match(policy.stdout, /\n {2}main +G0, and a signed approval\n/);
  assert.match(
    policy.stdout,
    /Approval \(a signature that only an owner can make\)\n {2}signers: owner\n {2}asked for: a change to a protected file, on every branch with a level\n {2}asked for: every commit that enters main\n {2}an approval counts for 24 hours, for one commit and one branch\n/,
  );

  assert.equal(runCli(s.repo, ['install']).status, 0);
  const doctor = runCli(s.repo, ['doctor']);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(
    doctor.stdout,
    /approval\s+LOCKED: 1 signer \(owner\)\n\s+a change to a protected file needs a signed approval, and so does every commit into main\n/,
  );
  assert.match(doctor.stdout, /- "git push" of a commit that needs an approval and has no valid one\./);
  assert.match(doctor.stdout, /- An approval made with a key that needs no passphrase, or that sits unlocked in the background\./);
  assert.doesNotMatch(doctor.stdout, /A change to the policy file that was merged like any other change/);
});

test('Claude Code is stopped from running "approve", and told to hand it to the user', (t) => {
  const s = scene(t);
  const call = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'gotreceipts approve --for main' },
  });
  const result = runCli(s.repo, ['hook', 'claude-code'], {}, call);
  assert.equal(result.status, 0, result.stderr);
  const answer = (JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> }).hookSpecificOutput;
  assert.equal(answer['permissionDecision'], 'deny');
  assert.match(answer['permissionDecisionReason'] ?? '', /"gotreceipts approve" is not for a coding agent to run/);
  assert.match(answer['permissionDecisionReason'] ?? '', /Tell the user which commit needs an approval, for which branch, and why/);
});

// --- the approve command itself ---

test('an approval without a record is given, with a plain warning that it does not replace the record', (t) => {
  const s = scene(t);
  writeIn(s.repo, 'data.txt', 'changed\n');
  assert.equal(gitIn(s.repo, 'commit', '--quiet', '--all', '-m', 'test: not gated').status, 0);

  const approved = approve(s.repo, s.owner, ['--for', 'main']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /record: NONE THAT COUNTS \(there is no record for this commit\)\. An approval does not replace the record/);

  const verify = runCli(s.repo, ['verify', '--for', 'main']);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /approved by owner/);
  assert.match(verify.stdout, /VERDICT: REFUSED \(there is no record for this commit\)/);
  assert.equal(lastLine(verify.stdout), 'To make a record: gotreceipts gate --for main');
});

test('another commit than the one that is checked out can be approved by name', (t) => {
  const s = scene(t);
  const first = gatedCommit(s.repo);
  gatedCommit(s.repo, 'data.txt', 'changed again\n');

  const approved = approve(s.repo, s.owner, [first.slice(0, 10), '--for', 'main']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.equal(existsSync(approvalFile(s.repo, first, 'main')), true);
  assert.equal(runCli(s.repo, ['verify', first, '--for', 'main']).status, 0);
  assert.equal(runCli(s.repo, ['verify', '--for', 'main']).status, 1, 'the newer commit is not approved by it');
});

test('a branch with a slash in its name gets a file name without one', (t) => {
  const s = scene(t, (owner) =>
    policyFor(owner, {
      tiers: [
        { branch: 'feature/*', level: 'G0' },
        { branch: 'version/*', level: 'G0', needsApproval: true },
        { branch: 'main', level: 'G0' },
      ],
    }),
  );
  const commit = gatedCommit(s.repo);

  const approved = approve(s.repo, s.owner, ['--for', 'version/1.0']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /policy: the one in this commit, because "version\/1\.0" does not exist yet/);
  assert.match(approved.stdout, new RegExp(`kept as \\.git/gotreceipts/approvals/${commit}/version%2F1\\.0\\.json`));
  assert.equal(runCli(s.repo, ['verify', '--for', 'version/1.0']).status, 0);
});

test('what "approve" cannot do, it says, and signs nothing', (t) => {
  const s = scene(t);
  gatedCommit(s.repo);

  const cases: [string[], RegExp][] = [
    [[], /CANNOT RUN: say which branch the commit is approved into: --for <branch>, or name a pull request with --pr/],
    [['nowhere', '--for', 'main'], /CANNOT RUN: there is no commit "nowhere"/],
    [['HEAD', 'HEAD~1', '--for', 'main'], /CANNOT RUN: name one commit, not several/],
    [['--for', 'notes'], /CANNOT RUN: the policy sets no level for "notes", so nothing there asks for an approval/],
    [['--pr', '7', '--for', 'main'], /CANNOT RUN: give either --pr, or a commit with --for, not both/],
    [['--pr', 'seven'], /CANNOT RUN: give the number of one pull request/],
  ];
  for (const [args, expected] of cases) {
    const result = approve(s.repo, s.owner, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, expected, args.join(' '));
    assert.doesNotMatch(result.stdout, /VERDICT/);
  }

  const noKey = runCli(s.repo, ['approve', '--for', 'main', '--key', join(s.repo, 'no-such-key')], {}, 'approve\n');
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /CANNOT RUN: there is no key file "/);

  const help = runCli(s.repo, ['approve', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: gotreceipts approve \[commit\] --for <branch> \[options\]/);
});

// --- when the signature cannot be checked ---

test('on a machine without ssh-keygen the signature cannot be checked, and that is never a pass', (t) => {
  const s = scene(t);
  const commit = gatedCommit(s.repo);
  assert.equal(approve(s.repo, s.owner, ['--for', 'main']).status, 0);

  const file = approvalFile(s.repo, commit, 'main');
  const signers = [{ name: 'owner', key: s.owner.publicKey }];
  assert.deepEqual(checkSignature(signers, readFileSync(file), `${file}.sig`), { kind: 'good', signer: 'owner' });
  assert.deepEqual(checkSignature(signers, readFileSync(file), `${file}.sig`, 'a-program-that-is-not-there'), {
    kind: 'cannot-check',
    reason: 'the program "ssh-keygen" was not found. It comes with OpenSSH',
  });
});
