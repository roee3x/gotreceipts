// Outside-in tests for records and approvals that travel: "send", "fetch", and what "approve"
// does when the policy says "travel".
//
// A server is played by a bare repository. Two clones of it stand for two machines.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { approvalText, newApproval } from '../src/approval/statement.ts';
import { addRemote, gitIn, lastLine, runCli, tempRepo, testKey, writeIn, type TestKey } from './helpers/temp-repo.ts';

/**
 * develop needs a record. main also asks for an approval of every commit. One signer, "owner".
 * The one check passes, unless the environment tells it to fail.
 */
function policyFor(owner: TestKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/flaky.js' }] }],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'develop', level: 'G0' },
      { branch: 'main', level: 'G0', needsApproval: true },
    ],
    approval: { signers: [{ name: 'owner', key: owner.publicKey }] },
    ...extra,
  };
}

interface Scene {
  /** The clone the work is done in, on feature/thing. */
  readonly first: string;
  /** Another clone of the same remote, as on another machine. */
  readonly second: string;
  readonly remote: string;
  readonly owner: TestKey;
}

/** A clone of `remote` in a folder of its own, removed when the test ends. */
function cloneOf(t: TestContext, remote: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-clone-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const cloned = gitIn(tmpdir(), 'clone', '--quiet', '--branch', 'main', remote, folder);
  assert.equal(cloned.status, 0, cloned.stderr);
  return folder;
}

function scene(t: TestContext, extra: Record<string, unknown> = {}): Scene {
  const owner = testKey(t);
  const first = tempRepo(t, { policy: policyFor(owner, extra) });
  const remote = addRemote(t, first);
  assert.equal(gitIn(first, 'push', '--quiet', 'origin', 'feature/thing:main', 'feature/thing:develop').status, 0);
  assert.equal(gitIn(first, 'fetch', '--quiet', 'origin').status, 0);
  return { first, second: cloneOf(t, remote), remote, owner };
}

/** Commits a change in `repo`, gates the commit, pushes the branch, and returns the commit. */
function gatedAndPushed(repo: string, content = 'changed\n'): string {
  writeIn(repo, 'data.txt', content);
  assert.equal(gitIn(repo, 'commit', '--quiet', '--all', '-m', 'test: a change').status, 0);
  const gate = runCli(repo, ['gate', '--level', 'G0']);
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.equal(gitIn(repo, 'push', '--quiet', '--force', 'origin', 'feature/thing').status, 0);
  return gitIn(repo, 'rev-parse', 'HEAD').stdout.trim();
}

/** What the remote holds under the name of the commit: the id of the small commit, or an empty text. */
function onRemote(s: Scene, commit: string): string {
  return gitIn(s.remote, 'rev-parse', '--verify', '--quiet', `refs/gotreceipts/${commit}`).stdout.trim();
}

function stored(repo: string, kind: 'records' | 'approvals', commit: string, name: string): string {
  return join(repo, '.git', 'gotreceipts', kind, commit, name);
}

/** Runs git with text on its input, and returns what it printed. For building a commit by hand. */
function gitWith(cwd: string, input: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Someone',
      GIT_AUTHOR_EMAIL: 'someone@example.com',
      GIT_COMMITTER_NAME: 'Someone',
      GIT_COMMITTER_EMAIL: 'someone@example.com',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Puts any files on the remote under the name of the commit, the way someone would by hand. */
function plantOnRemote(repo: string, commit: string, files: Record<string, string>): void {
  const folders = new Map<string, string[]>();
  for (const [path, content] of Object.entries(files)) {
    const [folder = '', name = ''] = path.split('/');
    const blob = gitWith(repo, content, 'hash-object', '-w', '--stdin');
    folders.set(folder, [...(folders.get(folder) ?? []), `100644 blob ${blob}\t${name}\n`]);
  }
  const top = [...folders].map(([folder, lines]) => `040000 tree ${gitWith(repo, lines.join(''), 'mktree')}\t${folder}\n`);
  const made = gitWith(repo, '', 'commit-tree', gitWith(repo, top.join(''), 'mktree'), '-m', 'put here by hand');
  assert.equal(gitIn(repo, 'push', '--quiet', 'origin', `${made}:refs/gotreceipts/${commit}`).status, 0);
}

// --- the central claim ---

test('a record made in one clone opens the door in another, after "send" and "fetch"', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  const short = commit.slice(0, 7);
  assert.equal(gitIn(s.second, 'fetch', '--quiet', 'origin').status, 0);

  // The other clone has the commit, and no record of it.
  const before = runCli(s.second, ['verify', commit, '--for', 'develop']);
  assert.equal(before.status, 1, before.stdout + before.stderr);
  assert.match(before.stdout, /VERDICT: REFUSED \(there is no record for this commit\)/);

  const sent = runCli(s.first, ['send']);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.ok(sent.stdout.includes(`gotreceipts send: commit ${short}, to origin`), sent.stdout);
  assert.match(sent.stdout, /\n {2}sent: 1 record\n/);
  assert.match(sent.stdout, /\n {2}origin now holds 1 record of this commit\n/);
  assert.equal(lastLine(sent.stdout), `Sent. Another clone gets them with: gotreceipts fetch ${short}`);
  assert.notEqual(onRemote(s, commit), '');

  const fetched = runCli(s.second, ['fetch', commit]);
  assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
  assert.ok(fetched.stdout.includes(`gotreceipts fetch: commit ${short}, from origin`), fetched.stdout);
  assert.match(fetched.stdout, /\n {2}origin holds 1 record of this commit\n/);
  assert.match(fetched.stdout, /\n {2}fetched: 1 record\n/);
  assert.equal(lastLine(fetched.stdout), `Fetched. Whether they count is for the door to say: gotreceipts verify ${short} --for <branch>`);

  // The file arrived as it left, byte for byte.
  assert.ok(readFileSync(stored(s.second, 'records', commit, 'G0.json')).equals(readFileSync(stored(s.first, 'records', commit, 'G0.json'))));

  const after = runCli(s.second, ['verify', commit, '--for', 'develop']);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.match(after.stdout, /G0 record, passed 0\.0 hours ago, under the current policy/);
});

test('a normal clone and a normal fetch do not download them, and they are no branch and no tag', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  assert.equal(runCli(s.first, ['send']).status, 0);

  const fresh = cloneOf(t, s.remote);
  assert.equal(gitIn(fresh, 'fetch', '--quiet', '--tags', 'origin').status, 0);
  assert.doesNotMatch(gitIn(fresh, 'for-each-ref').stdout, /gotreceipts/);
  assert.equal(existsSync(join(fresh, '.git', 'gotreceipts')), false);

  // On the remote it sits under a name of its own, next to the branches.
  const names = gitIn(s.remote, 'for-each-ref', '--format=%(refname)').stdout.trim().split('\n').sort();
  assert.deepEqual(names, [`refs/gotreceipts/${commit}`, 'refs/heads/develop', 'refs/heads/feature/thing', 'refs/heads/main']);

  // The small commit that carries them is made in the tool's own name, not in a person's.
  assert.equal(gitIn(s.remote, 'log', '-1', '--format=%an <%ae> | %cn <%ce>', `refs/gotreceipts/${commit}`).stdout.trim(), 'gotreceipts <receipts@gotreceipts.invalid> | gotreceipts <receipts@gotreceipts.invalid>');
});

test('an approval signed in one clone counts in another, and sending adds to what the remote holds', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  const short = commit.slice(0, 7);
  assert.equal(runCli(s.first, ['send']).status, 0);

  // The owner sits at the other machine: gets the record, signs there, and sends.
  assert.equal(gitIn(s.second, 'fetch', '--quiet', 'origin').status, 0);
  assert.equal(runCli(s.second, ['fetch', commit]).status, 0);
  const approved = runCli(s.second, ['approve', commit, '--for', 'main', '--key', s.owner.file], {}, 'approve\n');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.ok(approved.stdout.includes(`  it stays in this clone. To let another clone or CI see it: gotreceipts send ${short}`), approved.stdout);
  assert.equal(lastLine(approved.stdout), `VERDICT: APPROVED (commit ${short} into "main", by owner)`);

  const sent = runCli(s.second, ['send', commit]);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.match(sent.stdout, /\n {2}sent: 1 approval\n/);
  assert.match(sent.stdout, /\n {2}origin now holds 1 record and 1 approval of this commit\n/);

  // Nothing was overwritten on the remote: the second sending stands on top of the first.
  assert.equal(gitIn(s.remote, 'rev-list', '--count', `refs/gotreceipts/${commit}`).stdout.trim(), '2');

  const again = runCli(s.second, ['send', commit]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /origin already holds what this clone holds: 1 record and 1 approval/);
  assert.equal(lastLine(again.stdout), 'Nothing was sent.');
  assert.equal(gitIn(s.remote, 'rev-list', '--count', `refs/gotreceipts/${commit}`).stdout.trim(), '2');

  // Back at the first machine, the door into main is closed until the approval is fetched.
  assert.equal(runCli(s.first, ['verify', '--for', 'main']).status, 1);
  const fetched = runCli(s.first, ['fetch']);
  assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
  assert.match(fetched.stdout, /\n {2}origin holds 1 record and 1 approval of this commit\n/);
  assert.match(fetched.stdout, /\n {2}fetched: 1 approval\n/);

  for (const name of ['main.json', 'main.json.sig']) {
    assert.ok(readFileSync(stored(s.first, 'approvals', commit, name)).equals(readFileSync(stored(s.second, 'approvals', commit, name))), name);
  }
  const verify = runCli(s.first, ['verify', '--for', 'main']);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /approved by owner, 0\.0 hours ago/);

  const nothingNew = runCli(s.first, ['fetch']);
  assert.match(nothingNew.stdout, /this clone already has them, or newer ones/);
  assert.equal(lastLine(nothingNew.stdout), 'Nothing was fetched.');
});

test('a newer failed run travels too, and closes the door the older pass had opened', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  assert.equal(runCli(s.first, ['send']).status, 0);
  assert.equal(gitIn(s.second, 'fetch', '--quiet', 'origin').status, 0);
  assert.equal(runCli(s.second, ['fetch', commit]).status, 0);
  assert.equal(runCli(s.second, ['verify', commit, '--for', 'develop']).status, 0);

  // The same commit is gated again, and this time the check fails.
  const failed = runCli(s.first, ['gate', '--level', 'G0'], { GOTRECEIPTS_TEST_FAIL: '1' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const sent = runCli(s.first, ['send']);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.match(sent.stdout, /\n {2}sent: 1 record\n/);

  const fetched = runCli(s.second, ['fetch', commit]);
  assert.match(fetched.stdout, /\n {2}fetched: 1 record\n/);
  const verify = runCli(s.second, ['verify', commit, '--for', 'develop']);
  assert.equal(verify.status, 1, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /G0 record, failed 0\.0 hours ago/);
});

// --- what is on the remote is not believed ---

test('what someone put on the remote by hand is not taken, and does not stand in the way of an honest record', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  const short = commit.slice(0, 7);
  const real = JSON.parse(readFileSync(stored(s.first, 'records', commit, 'G0.json'), 'utf8')) as Record<string, unknown>;

  plantOnRemote(s.first, commit, {
    // A record of this commit that says it was made in the year 2099. Being the "newest", it would win for ever.
    'records/G0.json': `${JSON.stringify({ ...real, startedAt: '2099-01-01T00:00:00.000Z', finishedAt: '2099-01-01T00:00:05.000Z' }, null, 2)}\n`,
    // A record of another commit, and one that is no record.
    'records/G1.json': `${JSON.stringify({ ...real, commit: 'f'.repeat(40), level: 'G1' }, null, 2)}\n`,
    'records/G2.json': '{ "result": "pass" }\n',
    // An approval with no signature.
    'approvals/main.json': approvalText(newApproval(commit, 'main', '0.0.0', Date.now())),
    // Files that have no business there.
    'hooks/pre-push': '#!/bin/sh\nexit 1\n',
    'config/config': '[core]\n',
  });
  assert.equal(gitIn(s.second, 'fetch', '--quiet', 'origin').status, 0);

  const fetched = runCli(s.second, ['fetch', commit]);
  assert.equal(fetched.status, 0, fetched.stdout + fetched.stderr);
  assert.ok(fetched.stdout.includes(`  origin holds no record and no approval of commit ${short}`), fetched.stdout);
  assert.equal(lastLine(fetched.stdout), 'Nothing was fetched.');
  assert.equal(existsSync(join(s.second, '.git', 'gotreceipts')), false);
  assert.equal(existsSync(join(s.second, '.git', 'hooks', 'pre-push')), false);
  assert.equal(runCli(s.second, ['verify', commit, '--for', 'develop']).status, 1);

  // The honest record is sent on top, and arrives.
  const sent = runCli(s.first, ['send']);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.match(sent.stdout, /\n {2}origin now holds 1 record of this commit\n/);
  assert.match(runCli(s.second, ['fetch', commit]).stdout, /\n {2}fetched: 1 record\n/);
  assert.equal(runCli(s.second, ['verify', commit, '--for', 'develop']).status, 0);
});

test('a fetched approval counts only for its signature', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  const stranger = testKey(t);

  // Someone signs an approval with a key the policy does not list, and sends it.
  const approved = runCli(s.first, ['approve', '--for', 'main', '--key', stranger.file], {}, 'approve\n');
  assert.equal(approved.status, 1, approved.stdout + approved.stderr);
  // The command keeps nothing, so the same thing is done by hand.
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-forged-'));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const text = approvalText(newApproval(commit, 'main', '0.0.0', Date.now()));
  const statement = writeIn(folder, 'approval.json', text);
  assert.equal(spawnSync('ssh-keygen', ['-Y', 'sign', '-f', stranger.file, '-n', 'gotreceipts-approval', statement]).status, 0);
  plantOnRemote(s.first, commit, {
    'records/G0.json': readFileSync(stored(s.first, 'records', commit, 'G0.json'), 'utf8'),
    'approvals/main.json': text,
    'approvals/main.json.sig': readFileSync(`${statement}.sig`, 'utf8'),
  });

  assert.equal(gitIn(s.second, 'fetch', '--quiet', 'origin').status, 0);
  const fetched = runCli(s.second, ['fetch', commit]);
  assert.match(fetched.stdout, /\n {2}fetched: 1 record and 1 approval\n/);

  const verify = runCli(s.second, ['verify', commit, '--for', 'main']);
  assert.equal(verify.status, 1, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /the approval that is there does not count: it was not signed by a key the policy lists/);
});

// --- the commands ---

test('"send" does not pass through the push hooks of the clone, which are for commits that enter a branch', (t) => {
  const s = scene(t);
  const commit = gatedAndPushed(s.first);
  chmodSync(writeIn(s.first, '.git/hooks/pre-push', '#!/bin/sh\necho "this hook refuses every push" >&2\nexit 1\n'), 0o755);
  assert.notEqual(gitIn(s.first, 'push', '--quiet', 'origin', 'feature/thing:refs/heads/other').status, 0);

  const sent = runCli(s.first, ['send']);
  assert.equal(sent.status, 0, sent.stdout + sent.stderr);
  assert.notEqual(onRemote(s, commit), '');
});

test('"send" and "fetch" say plainly when there is nothing, and cannot run without a remote that answers', (t) => {
  const s = scene(t);
  const short = gitIn(s.first, 'rev-parse', '--short=7', 'HEAD').stdout.trim();

  const nothingToSend = runCli(s.first, ['send']);
  assert.equal(nothingToSend.status, 0, nothingToSend.stdout + nothingToSend.stderr);
  assert.ok(nothingToSend.stdout.includes(`  this clone holds no record and no approval of commit ${short}`), nothingToSend.stdout);
  assert.equal(lastLine(nothingToSend.stdout), 'Nothing was sent.');

  const nothingThere = runCli(s.first, ['fetch']);
  assert.equal(nothingThere.status, 0, nothingThere.stdout + nothingThere.stderr);
  assert.ok(nothingThere.stdout.includes(`  origin holds no record and no approval of commit ${short}`), nothingThere.stdout);
  assert.equal(lastLine(nothingThere.stdout), 'Nothing was fetched.');

  for (const command of ['send', 'fetch']) {
    const several = runCli(s.first, [command, 'HEAD', 'HEAD']);
    assert.equal(several.status, 2);
    assert.match(several.stderr, new RegExp(`gotreceipts ${command}: CANNOT RUN: name one commit, not several`));

    const unknown = runCli(s.first, [command, 'no-such-commit']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /CANNOT RUN: there is no commit "no-such-commit"/);

    const noSuchRemote = runCli(s.first, [command, '--remote', 'nowhere']);
    assert.equal(noSuchRemote.status, 2);
    assert.match(noSuchRemote.stderr, /CANNOT RUN: this repository has no remote "nowhere"/);

    const help = runCli(s.first, [command, '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, new RegExp(`^Usage: gotreceipts ${command} \\[commit\\] \\[options\\]`));
    assert.match(help.stdout, /refs\/gotreceipts\/<commit>/);
  }

  // A remote that does not answer is "could not run", for both. Never "nothing there".
  gatedAndPushed(s.first);
  assert.equal(gitIn(s.first, 'remote', 'add', 'gone', join(s.remote, 'not-here')).status, 0);
  for (const command of ['send', 'fetch']) {
    const gone = runCli(s.first, [command, '--remote', 'gone']);
    assert.equal(gone.status, 2, gone.stdout + gone.stderr);
    assert.match(gone.stderr, new RegExp(`gotreceipts ${command}: CANNOT RUN: `));
  }

  // Two remotes, and neither is called "origin": the command asks which.
  assert.equal(gitIn(s.first, 'remote', 'rename', 'origin', 'server').status, 0);
  const which = runCli(s.first, ['send']);
  assert.equal(which.status, 2);
  assert.match(which.stderr, /CANNOT RUN: say which remote, with --remote \(this repository has: gone, server\)/);
  assert.equal(runCli(s.first, ['send', '--remote', 'server']).status, 0);

  const alone = tempRepo(t, { policy: policyFor(s.owner) });
  const noRemote = runCli(alone, ['send']);
  assert.equal(noRemote.status, 2);
  assert.match(noRemote.stderr, /CANNOT RUN: this repository has no remote/);
});

// --- "travel" in the policy ---

test('with "travel" in the policy, "approve" sends the approval, and says so when it could not', (t) => {
  const s = scene(t, { travel: true });
  const commit = gatedAndPushed(s.first);
  const short = commit.slice(0, 7);

  const approved = runCli(s.first, ['approve', '--for', 'main', '--key', s.owner.file], {}, 'approve\n');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /\n {2}sent to origin: 1 record and 1 approval\n/);
  assert.equal(lastLine(approved.stdout), `VERDICT: APPROVED (commit ${short} into "main", by owner)`);

  // The other machine needs no word from this one.
  assert.equal(gitIn(s.second, 'fetch', '--quiet', 'origin').status, 0);
  assert.equal(runCli(s.second, ['fetch', commit]).status, 0);
  assert.equal(runCli(s.second, ['verify', commit, '--for', 'main']).status, 0);

  // The remote is gone. The approval is still given, and the last line says what is missing.
  const next = gatedAndPushed(s.first, 'changed again\n');
  assert.equal(gitIn(s.first, 'remote', 'set-url', 'origin', join(s.remote, 'not-here')).status, 0);
  const offline = runCli(s.first, ['approve', '--for', 'main', '--key', s.owner.file], {}, 'approve\n');
  assert.equal(offline.status, 0, offline.stdout + offline.stderr);
  assert.match(offline.stdout, /\n {2}NOT SENT to the remote: /);
  assert.ok(offline.stdout.includes(`VERDICT: APPROVED (commit ${next.slice(0, 7)} into "main", by owner)`), offline.stdout);
  assert.equal(
    lastLine(offline.stdout),
    `It is signed and kept, and other clones and CI cannot see it yet. Send it: gotreceipts send ${next.slice(0, 7)}`,
  );
  assert.equal(runCli(s.first, ['verify', '--for', 'main']).status, 0);
});

test('"policy" and "doctor" say whether records and approvals travel', (t) => {
  const stays = scene(t);
  assert.match(runCli(stays.first, ['policy']).stdout, /\nRecords and approvals stay in this clone, unless someone runs "gotreceipts send"\.\n/);
  assert.match(
    runCli(stays.first, ['doctor']).stdout,
    /\n {2}records\s+STAY IN THIS CLONE: another clone, and CI, cannot see them\n\s+they are sent only when someone runs "gotreceipts send"\n/,
  );

  const travels = scene(t, { travel: true });
  assert.match(
    runCli(travels.first, ['policy']).stdout,
    /\nRecords and approvals travel: "approve" and "merge" send them to the remote, and "merge" asks the remote for them\.\n/,
  );
  assert.match(
    runCli(travels.first, ['doctor']).stdout,
    /\n {2}records\s+TRAVEL: "approve" and "merge" send records and approvals to the remote\n\s+another clone gets them with "gotreceipts fetch"\n/,
  );
});
