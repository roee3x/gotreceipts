import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseLevel } from '../src/gate/command.ts';
import { unmetExpectation } from '../src/gate/run-checks.ts';
import { parsePolicy } from '../src/policy/parse.ts';
import type { Check, Expect, Policy } from '../src/policy/policy.ts';

function check(expect: Expect): Check {
  return { name: 'test', run: 'npm test', timeoutMinutes: 30, expect };
}

function policy(): Policy {
  const result = parsePolicy(
    JSON.stringify({
      schema: 1,
      levels: [
        { name: 'G0', checks: [{ name: 'build', run: 'npm run build' }] },
        { name: 'G1', checks: [{ name: 'test', run: 'npm test' }] },
      ],
      tiers: [
        { branch: 'feature/*', level: 'G0' },
        { branch: 'main', level: 'G1' },
      ],
    }),
  );
  assert.ok(result.ok);
  return result.policy;
}

test('with no expectations, any output is fine', () => {
  assert.equal(unmetExpectation(check({}), ''), undefined);
  assert.equal(unmetExpectation(check({}), 'anything'), undefined);
});

test('an expected line must appear somewhere in the output', () => {
  const withVerdict = check({ output: '^VERDICT: PASS$' });
  assert.equal(unmetExpectation(withVerdict, 'building\nVERDICT: PASS\ndone'), undefined);
  assert.match(unmetExpectation(withVerdict, 'building\ndone') ?? '', /does not contain the expected line/);
  // The verdict must be a line of its own, not part of another line.
  assert.match(unmetExpectation(withVerdict, 'no VERDICT: PASS here') ?? '', /does not contain the expected line/);
});

test('a count must be shown and must reach the minimum', () => {
  const counted = check({ count: { pattern: '(\\d+) ran', atLeast: 1 } });
  assert.equal(unmetExpectation(counted, '12 ran, 0 failed'), undefined);
  assert.match(unmetExpectation(counted, '0 ran, 0 failed') ?? '', /shows a count of 0, and at least 1 is needed/);
  assert.match(unmetExpectation(counted, 'all green!') ?? '', /does not show the expected count/);
});

test('when the count appears more than once, the last one is the one that counts', () => {
  const counted = check({ count: { pattern: '(\\d+) ran', atLeast: 5 } });
  assert.equal(unmetExpectation(counted, 'file a: 2 ran\nfile b: 3 ran\ntotal: 5 ran'), undefined);
  assert.match(unmetExpectation(counted, 'total: 9 ran\nretry: 0 ran') ?? '', /shows a count of 0/);
});

test('a count that is not a number does not pass', () => {
  const counted = check({ count: { pattern: 'ran: (\\w+)', atLeast: 1 } });
  assert.match(unmetExpectation(counted, 'ran: many') ?? '', /is not a number/);
});

test('both expectations must hold', () => {
  const both = check({ output: 'VERDICT: PASS', count: { pattern: '(\\d+) ran', atLeast: 1 } });
  assert.equal(unmetExpectation(both, '3 ran\nVERDICT: PASS'), undefined);
  assert.notEqual(unmetExpectation(both, '3 ran'), undefined);
  assert.notEqual(unmetExpectation(both, 'VERDICT: PASS'), undefined);
});

test('the level comes from --level, then --for, then the current branch', () => {
  const p = policy();
  assert.deepEqual(chooseLevel(p, { level: 'G1' }, 'feature/x'), { level: 'G1' });
  assert.deepEqual(chooseLevel(p, { for: 'main' }, 'feature/x'), { level: 'G1' });
  assert.deepEqual(chooseLevel(p, {}, 'feature/x'), { level: 'G0' });
  assert.deepEqual(chooseLevel(p, {}, 'main'), { level: 'G1' });
});

test('a level that cannot be worked out is an error, never a guess', () => {
  const p = policy();
  const error = (result: ReturnType<typeof chooseLevel>): string => ('error' in result ? result.error : '');

  assert.match(error(chooseLevel(p, { level: 'G9' }, 'main')), /no level "G9" \(levels: G0, G1\)/);
  assert.match(error(chooseLevel(p, { for: 'release' }, 'main')), /no tier for the branch "release"/);
  assert.match(error(chooseLevel(p, {}, 'scratch')), /no tier for the branch "scratch", so give --level or --for/);
  assert.match(error(chooseLevel(p, {}, undefined)), /no branch is checked out/);
  assert.match(error(chooseLevel(p, { level: 'G0', for: 'main' }, 'main')), /not both/);
});
