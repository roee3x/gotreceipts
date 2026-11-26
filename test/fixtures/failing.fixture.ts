// Used by run-tests.blackbox.test.ts. The name does not end in .test.ts,
// so the normal test run does not pick it up.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a test that fails on purpose', () => {
  assert.equal(1, 2);
});
