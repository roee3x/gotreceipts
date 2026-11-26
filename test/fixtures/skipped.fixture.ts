// Used by run-tests.blackbox.test.ts. The name does not end in .test.ts,
// so the normal test run does not pick it up.
import { test } from 'node:test';

test.skip('a test that is skipped', () => {});
