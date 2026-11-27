import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalText, newApproval } from '../src/approval/statement.ts';
import type { GateRecord } from '../src/record/record.ts';
import { countOf, mergeReceipts, notFromTheFuture, receiptsRef, sortIntoReceipts, type Receipt } from '../src/travel/receipt.ts';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'd'.repeat(40);

/** The text of a valid record of COMMIT. Tests change one thing. */
function recordText(change: Partial<GateRecord> = {}): Buffer {
  const record: GateRecord = {
    schema: 1,
    tool: { name: 'gotreceipts', version: '0.3.0' },
    commit: COMMIT,
    tree: 'b'.repeat(40),
    branch: 'feature/thing',
    level: 'G1',
    policyId: `sha256:${'c'.repeat(64)}`,
    result: 'pass',
    reason: 'all 1 checks passed',
    startedAt: '2026-01-31T12:00:00.000Z',
    finishedAt: '2026-01-31T12:00:05.000Z',
    checks: [{ name: 'build', command: 'npm run build', status: 'pass', exitCode: 0, timedOut: false, durationMs: 5000, reason: 'exit code 0' }],
    platform: { os: 'linux', arch: 'x64', node: 'v24.0.0' },
    ...change,
  };
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
}

function approvalFiles(branch: string, commit = COMMIT, when = Date.parse('2026-01-31T13:00:00.000Z')): [Buffer, Buffer] {
  return [Buffer.from(approvalText(newApproval(commit, branch, '0.3.0', when))), Buffer.from('a signature\n')];
}

function keys(receipts: readonly Receipt[]): string[] {
  return receipts.map((receipt) => receipt.key);
}

/** True when two receipts hold the same files with the same content. */
function sameReceipt(a: Receipt, b: Receipt): boolean {
  if (a.files.size !== b.files.size) return false;
  for (const [path, content] of a.files) {
    const other = b.files.get(path);
    if (other === undefined || !other.equals(content)) return false;
  }
  return true;
}

/** True when both sets hold the same receipts. */
function sameReceipts(a: readonly Receipt[], b: readonly Receipt[]): boolean {
  return a.length === b.length && a.every((receipt) => b.some((other) => other.key === receipt.key && sameReceipt(receipt, other)));
}

test('the place on the remote is named after the commit, outside the branches and the tags', () => {
  assert.equal(receiptsRef(COMMIT), `refs/gotreceipts/${COMMIT}`);
});

test('a record and an approval with its signature are taken, each under its own key', () => {
  const [statement, signature] = approvalFiles('version/0.3');
  const receipts = sortIntoReceipts(
    COMMIT,
    new Map([
      ['records/G1.json', recordText()],
      ['approvals/version%2F0.3.json', statement],
      ['approvals/version%2F0.3.json.sig', signature],
    ]),
  );
  assert.deepEqual(keys(receipts), ['approvals/version%2F0.3', 'records/G1']);
  assert.deepEqual(
    receipts.map((receipt) => [receipt.kind, receipt.files.size]),
    [
      ['approval', 2],
      ['record', 1],
    ],
  );
  assert.equal(receipts[1]?.time, Date.parse('2026-01-31T12:00:05.000Z'));
  // The bytes are kept as they came. A signature is checked against exactly these.
  assert.ok(receipts[0]?.files.get('approvals/version%2F0.3.json')?.equals(statement));
});

test('a file that is not exactly a record or an approval of this commit is left out', () => {
  const [statement, signature] = approvalFiles('main');
  const [otherCommit] = approvalFiles('main', OTHER_COMMIT);
  const leftOut: [string, Map<string, Buffer>][] = [
    ['a record of another commit', new Map([['records/G1.json', recordText({ commit: OTHER_COMMIT })]])],
    ['a record under the name of another level', new Map([['records/G2.json', recordText()]])],
    ['a record that does not read', new Map([['records/G1.json', Buffer.from('{ half a file')]])],
    ['a record that says "pass" with a failed check', new Map([['records/G1.json', Buffer.from(recordText().toString().replace('"status": "pass"', '"status": "fail"'))]])],
    ['an approval without its signature', new Map([['approvals/main.json', statement]])],
    ['a signature without its approval', new Map([['approvals/main.json.sig', signature]])],
    [
      'an approval of another commit',
      new Map([
        ['approvals/main.json', otherCommit],
        ['approvals/main.json.sig', signature],
      ]),
    ],
    [
      'an approval under the name of another branch',
      new Map([
        ['approvals/develop.json', statement],
        ['approvals/develop.json.sig', signature],
      ]),
    ],
    ['a file in another folder', new Map([['hooks/pre-push', Buffer.from('#!/bin/sh\n')]])],
    ['a file at the top', new Map([['G1.json', recordText()]])],
    ['a file one folder deeper', new Map([['records/deeper/G1.json', recordText()]])],
    ['a name that climbs out of the folder', new Map([['records/../../config.json', recordText()]])],
    ['a file that is far too large', new Map([['records/G1.json', Buffer.concat([recordText(), Buffer.alloc(2 * 1024 * 1024, 32)])]])],
  ];
  for (const [what, files] of leftOut) {
    assert.deepEqual(sortIntoReceipts(COMMIT, files), [], what);
  }
});

test('of two with the same key the newer one stays, whichever side it is on', () => {
  const older = sortIntoReceipts(COMMIT, new Map([['records/G1.json', recordText()]]));
  const newerFail = sortIntoReceipts(
    COMMIT,
    new Map([
      [
        'records/G1.json',
        recordText({
          result: 'fail',
          reason: 'the check "build" failed: exit code 1',
          finishedAt: '2026-01-31T15:00:00.000Z',
          checks: [{ name: 'build', command: 'npm run build', status: 'fail', exitCode: 1, timedOut: false, durationMs: 5, reason: 'exit code 1' }],
        }),
      ],
    ]),
  );

  // A newer failed run arrives: it replaces the older pass.
  const arrived = mergeReceipts(older, newerFail);
  assert.equal(arrived.gained.length, 1);
  assert.ok(sameReceipts(arrived.all, newerFail));

  // An older pass arrives: the newer failed run is not hidden behind it.
  const stale = mergeReceipts(newerFail, older);
  assert.deepEqual(stale.gained, []);
  assert.ok(sameReceipts(stale.all, newerFail));

  // The same thing twice is nothing new.
  assert.deepEqual(mergeReceipts(older, older).gained, []);
});

test('two sets are put together, and only what was lacking counts as gained', () => {
  const [statement, signature] = approvalFiles('main');
  const record = sortIntoReceipts(COMMIT, new Map([['records/G1.json', recordText()]]));
  const approval = sortIntoReceipts(
    COMMIT,
    new Map([
      ['approvals/main.json', statement],
      ['approvals/main.json.sig', signature],
    ]),
  );
  const merged = mergeReceipts(record, [...record, ...approval]);
  assert.deepEqual(keys(merged.all), ['approvals/main', 'records/G1']);
  assert.deepEqual(keys(merged.gained), ['approvals/main']);
  assert.equal(sameReceipts(merged.all, record), false);
});

test('what is dated in the future is left out, with a few minutes of allowance for two clocks', () => {
  const now = Date.parse('2026-01-31T12:00:00.000Z');
  const at = (finishedAt: string): Receipt[] => sortIntoReceipts(COMMIT, new Map([['records/G1.json', recordText({ finishedAt })]]));
  assert.equal(notFromTheFuture(at('2026-01-31T11:00:00.000Z'), now).length, 1);
  assert.equal(notFromTheFuture(at('2026-01-31T12:04:00.000Z'), now).length, 1);
  assert.equal(notFromTheFuture(at('2026-01-31T12:06:00.000Z'), now).length, 0);
  assert.equal(notFromTheFuture(at('2036-01-31T12:00:00.000Z'), now).length, 0);
});

test('a count in words', () => {
  const [statement, signature] = approvalFiles('main');
  const record = sortIntoReceipts(COMMIT, new Map([['records/G1.json', recordText()]]));
  const second = sortIntoReceipts(COMMIT, new Map([['records/G2.json', recordText({ level: 'G2' })]]));
  const approval = sortIntoReceipts(
    COMMIT,
    new Map([
      ['approvals/main.json', statement],
      ['approvals/main.json.sig', signature],
    ]),
  );
  assert.equal(countOf([]), 'nothing');
  assert.equal(countOf(record), '1 record');
  assert.equal(countOf([...record, ...second]), '2 records');
  assert.equal(countOf(approval), '1 approval');
  assert.equal(countOf([...record, ...second, ...approval]), '2 records and 1 approval');
});
