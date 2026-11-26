import assert from 'node:assert/strict';
import { test } from 'node:test';

import { policyId } from '../src/policy/hash.ts';
import { parsePolicy } from '../src/policy/parse.ts';
import { checksForLevel, type Policy } from '../src/policy/policy.ts';
import type { GateRecord } from '../src/record/record.ts';
import { decide, type Decision } from '../src/verify/decide.ts';

/** "Now" for every test here. The decision is given the time, so nothing depends on the real clock. */
const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

function makePolicy(): Policy {
  const result = parsePolicy(
    JSON.stringify({
      schema: 1,
      levels: [
        { name: 'G0', checks: [{ name: 'build', run: 'npm run build' }] },
        { name: 'G1', checks: [{ name: 'test', run: 'npm test' }] },
        { name: 'G2', checks: [{ name: 'pack', run: 'npm pack' }] },
      ],
      tiers: [{ branch: 'main', level: 'G2' }],
    }),
  );
  assert.ok(result.ok);
  return result.policy;
}

const POLICY = makePolicy();
const CURRENT = policyId(POLICY);
const OTHER = `sha256:${'0'.repeat(64)}`;

interface RecordSpec {
  level: string;
  /** How long ago the run finished, in milliseconds. Negative means dated in the future. */
  ago: number;
  /** The name of the check that failed. Leave out for a run where every check passed. */
  failed?: string;
  /** Set for a run that failed although no check failed (the files changed during the run). */
  changedDuringRun?: boolean;
  policyId?: string;
}

function record(spec: RecordSpec): GateRecord {
  const checks = checksForLevel(POLICY, spec.level) ?? [];
  let seenFailure = false;
  const results = checks.map((check) => {
    const status = seenFailure ? 'skipped' : check.name === spec.failed ? 'fail' : 'pass';
    if (status === 'fail') seenFailure = true;
    return {
      name: check.name,
      command: check.run,
      status,
      exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : null,
      timedOut: false,
      durationMs: 1000,
      reason: status === 'pass' ? 'exit code 0' : status === 'fail' ? 'exit code 1' : 'an earlier check failed',
    } as const;
  });
  const failedRun = spec.failed !== undefined || spec.changedDuringRun === true;
  const finishedAt = new Date(NOW - spec.ago).toISOString();
  return {
    schema: 1,
    tool: { name: 'gotreceipts', version: '0.1.0' },
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    branch: 'feature/thing',
    level: spec.level,
    policyId: spec.policyId ?? CURRENT,
    result: failedRun ? 'fail' : 'pass',
    reason:
      spec.failed !== undefined
        ? `the check "${spec.failed}" failed: exit code 1`
        : spec.changedDuringRun === true
          ? 'the commit or the files changed while the gate was running'
          : `all ${results.length} checks passed`,
    startedAt: finishedAt,
    finishedAt,
    checks: results,
    platform: { os: 'linux', arch: 'x64', node: 'v24.0.0' },
  };
}

function ask(requiredLevel: string, ...records: GateRecord[]): Decision {
  return decide({ policy: POLICY, policyId: CURRENT, requiredLevel, records, now: NOW });
}

function refusal(decision: Decision): { summary: string; details: string } {
  assert.equal(decision.ok, false, 'the commit was accepted but should have been refused');
  return decision.ok ? { summary: '', details: '' } : { summary: decision.summary, details: decision.details.join('\n') };
}

test('no record at all is a refusal', () => {
  assert.equal(refusal(ask('G0')).summary, 'there is no record for this commit');
});

test('a fresh passing record at the needed level, under the current policy, is accepted', () => {
  const decision = ask('G1', record({ level: 'G1', ago: 2 * HOUR }));
  assert.ok(decision.ok);
  assert.equal(decision.record.level, 'G1');
  assert.equal(decision.ageHours, 2);
});

test('a record of a higher level also covers the lower levels', () => {
  assert.ok(ask('G0', record({ level: 'G2', ago: HOUR })).ok);
  assert.ok(ask('G1', record({ level: 'G2', ago: HOUR })).ok);
});

test('a record of a lower level does not cover a higher one', () => {
  const { summary, details } = refusal(ask('G1', record({ level: 'G0', ago: HOUR })));
  assert.equal(summary, 'no record of this commit satisfies level G1');
  assert.match(details, /G0 record, passed 1\.0 hours ago: its level is below G1/);
});

test('a record made under another policy does not count', () => {
  const { details } = refusal(ask('G0', record({ level: 'G2', ago: HOUR, policyId: OTHER })));
  assert.match(details, /it was made under a different policy than the current one/);
});

test('a failed record does not count, and its reason is shown', () => {
  const { details } = refusal(ask('G1', record({ level: 'G1', ago: HOUR, failed: 'test' })));
  assert.match(details, /G1 record, failed 1\.0 hours ago: the check "test" failed: exit code 1/);
});

test('a record counts for the number of hours the policy says, and not a minute longer', () => {
  assert.ok(ask('G0', record({ level: 'G0', ago: 24 * HOUR })).ok, 'exactly 24 hours old still counts');
  const { details } = refusal(ask('G0', record({ level: 'G0', ago: 24 * HOUR + MINUTE })));
  assert.match(details, /it is older than the 24 hours a record counts for/);
});

test('a record dated in the future is not trusted, apart from a small clock difference', () => {
  assert.ok(ask('G0', record({ level: 'G0', ago: -4 * MINUTE })).ok, 'four minutes ahead is a clock difference');
  const { details } = refusal(ask('G0', record({ level: 'G0', ago: -6 * MINUTE })));
  assert.match(details, /it is dated in the future/);
  assert.match(details, /passed 0\.0 hours ago/, 'a negative age is never shown');
});

test('the newest record that qualifies is the one that is used', () => {
  const decision = ask('G0', record({ level: 'G0', ago: 3 * HOUR }), record({ level: 'G1', ago: HOUR }));
  assert.ok(decision.ok);
  assert.equal(decision.record.level, 'G1');
});

test('a newer failure in a check the level needs takes the older pass away', () => {
  const pass = record({ level: 'G1', ago: 2 * HOUR });
  const laterFailure = record({ level: 'G0', ago: HOUR, failed: 'build' });

  for (const level of ['G0', 'G1']) {
    const { summary, details } = refusal(ask(level, pass, laterFailure));
    assert.equal(summary, `the newest run that matters for level ${level} failed`);
    assert.match(details, /G1 record, passed 2\.0 hours ago: a newer run failed after it/);
    assert.match(details, /G0 record, failed 1\.0 hours ago: the check "build" failed/);
  }
});

test('a newer failure in a check that only a higher level adds does not count against the lower level', () => {
  const pass = record({ level: 'G0', ago: 2 * HOUR });
  const laterFailure = record({ level: 'G1', ago: HOUR, failed: 'test' });

  assert.ok(ask('G0', pass, laterFailure).ok, 'the build passed in both runs');
  assert.equal(refusal(ask('G1', pass, laterFailure)).summary, 'no record of this commit satisfies level G1');
});

test('an older failure does not count against a newer pass', () => {
  const earlierFailure = record({ level: 'G0', ago: 2 * HOUR, failed: 'build' });
  const pass = record({ level: 'G1', ago: HOUR });
  assert.ok(ask('G0', earlierFailure, pass).ok);
  assert.ok(ask('G1', earlierFailure, pass).ok);
});

test('a newer run that failed because the files changed under it takes the older pass away', () => {
  const pass = record({ level: 'G1', ago: 2 * HOUR });
  const changed = record({ level: 'G2', ago: HOUR, changedDuringRun: true });
  const { details } = refusal(ask('G0', pass, changed));
  assert.match(details, /the commit or the files changed while the gate was running/);
});

test('a newer failure under another policy says nothing about the current one', () => {
  const pass = record({ level: 'G1', ago: 2 * HOUR });
  const otherPolicyFailure = record({ level: 'G0', ago: HOUR, failed: 'build', policyId: OTHER });
  assert.ok(ask('G1', pass, otherPolicyFailure).ok);
});

test('the order the records are given in does not change the answer', () => {
  const pass = record({ level: 'G1', ago: 2 * HOUR });
  const laterFailure = record({ level: 'G0', ago: HOUR, failed: 'build' });
  assert.equal(ask('G1', pass, laterFailure).ok, false);
  assert.equal(ask('G1', laterFailure, pass).ok, false);
});
