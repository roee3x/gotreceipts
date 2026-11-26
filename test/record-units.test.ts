import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRecord, scrubPaths, type GateRecord } from '../src/record/record.ts';

/** A complete, valid record. Tests copy it and break one thing. */
function validRecord(): Record<string, any> {
  const record: GateRecord = {
    schema: 1,
    tool: { name: 'gotreceipts', version: '0.1.0' },
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    branch: 'feature/thing',
    level: 'G1',
    policyId: `sha256:${'c'.repeat(64)}`,
    result: 'pass',
    reason: 'all 1 checks passed',
    startedAt: '2026-01-31T12:00:00.000Z',
    finishedAt: '2026-01-31T12:00:05.000Z',
    checks: [
      {
        name: 'build',
        command: 'npm run build',
        status: 'pass',
        exitCode: 0,
        timedOut: false,
        durationMs: 5000,
        reason: 'exit code 0',
      },
    ],
    platform: { os: 'linux', arch: 'x64', node: 'v24.0.0' },
  };
  return structuredClone(record) as Record<string, any>;
}

function errorOf(raw: unknown): string {
  const result = parseRecord(typeof raw === 'string' ? raw : JSON.stringify(raw));
  assert.equal(result.ok, false, 'the record was accepted but should have been refused');
  return result.ok ? '' : result.error;
}

test('a valid record is read back unchanged', () => {
  const raw = validRecord();
  const result = parseRecord(JSON.stringify(raw));
  assert.ok(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(result.record, raw);
});

test('a detached run has a null branch', () => {
  const raw = validRecord();
  raw['branch'] = null;
  assert.ok(parseRecord(JSON.stringify(raw)).ok);
});

test('text that is not a JSON object is not a record', () => {
  assert.match(errorOf('{ half a file'), /not valid JSON/);
  assert.match(errorOf('[]'), /not a JSON object/);
});

test('a missing or malformed field makes the whole record invalid', () => {
  const cases: Array<[string, (raw: Record<string, any>) => void]> = [
    ['schema', (raw) => (raw['schema'] = 2)],
    ['tool', (raw) => (raw['tool'].name = 'something-else')],
    ['commit', (raw) => (raw['commit'] = 'abc123')],
    ['tree', (raw) => delete raw['tree']],
    ['branch', (raw) => (raw['branch'] = 7)],
    ['level', (raw) => (raw['level'] = '')],
    ['policyId', (raw) => (raw['policyId'] = 'md5:123')],
    ['result', (raw) => (raw['result'] = 'passed')],
    ['reason', (raw) => delete raw['reason']],
    ['startedAt', (raw) => (raw['startedAt'] = 'yesterday')],
    ['finishedAt', (raw) => (raw['finishedAt'] = '2026-01-31 12:00')],
    ['checks', (raw) => (raw['checks'] = 'none')],
    ['checks', (raw) => (raw['checks'][0].status = 'ok')],
    ['checks', (raw) => delete raw['checks'][0].exitCode],
    ['platform', (raw) => delete raw['platform'].node],
  ];
  for (const [field, breakIt] of cases) {
    const raw = validRecord();
    breakIt(raw);
    assert.match(errorOf(raw), new RegExp(`the field "${field}" is missing or malformed`));
  }
});

test('a record must agree with itself: "pass" needs every check to have passed', () => {
  const failedCheck = validRecord();
  failedCheck['checks'][0].status = 'fail';
  assert.match(errorOf(failedCheck), /says "pass" but not every check in it passed/);

  const skippedCheck = validRecord();
  skippedCheck['checks'][0].status = 'skipped';
  assert.match(errorOf(skippedCheck), /says "pass" but not every check in it passed/);

  const noChecks = validRecord();
  noChecks['checks'] = [];
  assert.match(errorOf(noChecks), /says "pass" but lists no checks/);
});

test('a failed record may hold failed and skipped checks', () => {
  const raw = validRecord();
  raw['result'] = 'fail';
  raw['checks'][0].status = 'fail';
  assert.ok(parseRecord(JSON.stringify(raw)).ok);
});

test('folder paths of the machine are removed from text, in both slash directions and any case', () => {
  const paths = { root: 'C:/Work/Some Project', home: 'C:\\Users\\Someone' };

  assert.equal(scrubPaths('cannot open C:/Work/Some Project/src/a.ts', paths), 'cannot open <repo>/src/a.ts');
  assert.equal(scrubPaths('cannot open C:\\Work\\Some Project\\src\\a.ts', paths), 'cannot open <repo>\\src\\a.ts');
  assert.equal(scrubPaths('cannot open c:/work/some project/src', paths), 'cannot open <repo>/src');
  assert.equal(scrubPaths('cache at C:\\Users\\Someone\\.cache', paths), 'cache at <home>\\.cache');
  assert.equal(scrubPaths('cache at C:/Users/Someone/.cache', paths), 'cache at <home>/.cache');
  assert.equal(scrubPaths('nothing to hide', paths), 'nothing to hide');
});

test('a repository inside the home folder is replaced as the repository, not as the home folder', () => {
  const paths = { root: '/home/someone/code/project', home: '/home/someone' };
  assert.equal(scrubPaths('/home/someone/code/project/a.ts and /home/someone/.npm', paths), '<repo>/a.ts and <home>/.npm');
});
