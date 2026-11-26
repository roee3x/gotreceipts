// Runs the test files and fails when no test ran.
//
// Node's own test runner exits 0 when the pattern matches no file at all.
// A renamed folder or a typo in the pattern would then look like a green run.
// Here, zero tests is a failure.
//
// Usage: node scripts/run-tests.ts "<glob>" ["<glob>" ...]

import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  console.error('run-tests: give at least one file pattern.');
  process.exit(2);
}

let ran = 0;
let failed = 0;

const events = run({ globPatterns: patterns });

events.on('test:pass', (event) => {
  const isSuite = event.details.type === 'suite';
  const wasSkipped = event.skip !== undefined || event.todo !== undefined;
  if (!isSuite && !wasSkipped) ran += 1;
});
events.on('test:fail', () => {
  failed += 1;
});

const report = events.compose(spec);
report.pipe(process.stdout);
await finished(report);

if (failed > 0) {
  console.error(`run-tests: ${failed} failed.`);
  process.exitCode = 1;
} else if (ran === 0) {
  console.error('run-tests: no test ran. Zero tests is a failure, not a pass.');
  process.exitCode = 1;
} else {
  console.log(`run-tests: ${ran} ran, 0 failed.`);
}
