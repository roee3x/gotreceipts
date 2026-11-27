import assert from 'node:assert/strict';
import { test } from 'node:test';

import { policyId } from '../src/policy/hash.ts';
import { parsePolicy } from '../src/policy/parse.ts';
import { checksForLevel, isProtectedPath, levelRank, protectedPatterns, tierForBranch, type Policy } from '../src/policy/policy.ts';

/** A complete, valid policy as a plain object. Tests copy it and break one thing. */
function validRaw(): Record<string, any> {
  return {
    schema: 1,
    levels: [
      {
        name: 'G0',
        checks: [
          { name: 'build', run: 'npm run build' },
          {
            name: 'test',
            run: 'npm test',
            timeoutMinutes: 10,
            expect: { output: 'VERDICT: PASS', count: { pattern: '(\\d+) ran', atLeast: 1 } },
          },
        ],
      },
      { name: 'G1', checks: [{ name: 'words', run: 'gotreceipts words' }] },
      { name: 'G2', checks: [] },
    ],
    tiers: [
      { branch: 'feature/*', level: 'G0' },
      { branch: 'version/*', level: 'G1' },
      { branch: 'main', level: 'G2' },
    ],
    record: { maxAgeHours: 12 },
  };
}

function parseValid(raw: unknown): Policy {
  const result = parsePolicy(JSON.stringify(raw));
  assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
  return result.policy;
}

/** Parses a policy that must be refused and returns the error messages. */
function errorsOf(raw: unknown): readonly string[] {
  const result = parsePolicy(typeof raw === 'string' ? raw : JSON.stringify(raw));
  assert.equal(result.ok, false, 'the policy was accepted but should have been refused');
  return result.ok ? [] : result.errors;
}

function assertError(raw: unknown, expected: RegExp): void {
  const errors = errorsOf(raw);
  assert.ok(
    errors.some((error) => expected.test(error)),
    `no error matched ${expected}. Errors:\n${errors.join('\n')}`,
  );
}

test('a valid policy is read, with defaults filled in', () => {
  const policy = parseValid(validRaw());
  assert.equal(policy.schema, 1);
  assert.deepEqual(
    policy.levels.map((level) => level.name),
    ['G0', 'G1', 'G2'],
  );
  const build = policy.levels[0]?.checks[0];
  assert.deepEqual(build, { name: 'build', run: 'npm run build', timeoutMinutes: 30, expect: {} });
  const testCheck = policy.levels[0]?.checks[1];
  assert.equal(testCheck?.timeoutMinutes, 10);
  assert.deepEqual(testCheck?.expect, { output: 'VERDICT: PASS', count: { pattern: '(\\d+) ran', atLeast: 1 } });
  assert.equal(policy.record.maxAgeHours, 12);
});

test('the record section is optional and defaults to 24 hours', () => {
  const raw = validRaw();
  delete raw['record'];
  assert.equal(parseValid(raw).record.maxAgeHours, 24);
});

test('a level runs its own checks and those of every level before it', () => {
  const policy = parseValid(validRaw());
  const names = (level: string) => checksForLevel(policy, level)?.map((check) => check.name);
  assert.deepEqual(names('G0'), ['build', 'test']);
  assert.deepEqual(names('G1'), ['build', 'test', 'words']);
  assert.deepEqual(names('G2'), ['build', 'test', 'words']);
  assert.equal(names('G9'), undefined);
  assert.equal(levelRank(policy, 'G1'), 1);
  assert.equal(levelRank(policy, 'G9'), -1);
});

test('a branch is matched to its tier, and * stands for any run of characters', () => {
  const policy = parseValid(validRaw());
  assert.equal(tierForBranch(policy, 'feature/login')?.level, 'G0');
  assert.equal(tierForBranch(policy, 'feature/deep/er')?.level, 'G0');
  assert.equal(tierForBranch(policy, 'version/0.1')?.level, 'G1');
  assert.equal(tierForBranch(policy, 'main')?.level, 'G2');
  assert.equal(tierForBranch(policy, 'maintenance'), undefined);
  assert.equal(tierForBranch(policy, 'my-feature/login'), undefined);
  assert.equal(tierForBranch(policy, 'scratch'), undefined);
});

test('when two tiers match, the first one in the list wins', () => {
  const raw = validRaw();
  raw['tiers'] = [
    { branch: 'version/0.1', level: 'G2' },
    { branch: 'version/*', level: 'G1' },
  ];
  const policy = parseValid(raw);
  assert.equal(tierForBranch(policy, 'version/0.1')?.level, 'G2');
  assert.equal(tierForBranch(policy, 'version/0.2')?.level, 'G1');
});

test('text that is not JSON is refused', () => {
  assertError('{ not json', /not valid JSON/);
  assertError('[]', /must be a JSON object/);
});

test('an unknown setting is refused, at every depth', () => {
  const top = validRaw();
  top['tier'] = [];
  assertError(top, /^tier: unknown setting/);

  const inCheck = validRaw();
  inCheck['levels'][0].checks[0].comand = 'npm run build';
  assertError(inCheck, /^levels\[0\]\.checks\[0\]\.comand: unknown setting/);

  const inExpect = validRaw();
  inExpect['levels'][0].checks[1].expect.outputs = 'x';
  assertError(inExpect, /^levels\[0\]\.checks\[1\]\.expect\.outputs: unknown setting/);

  const inRecord = validRaw();
  inRecord['record'].maxAgeDays = 1;
  assertError(inRecord, /^record\.maxAgeDays: unknown setting/);
});

test('the schema number must be 1', () => {
  const raw = validRaw();
  raw['schema'] = 2;
  assertError(raw, /^schema: must be 1/);
  delete raw['schema'];
  assertError(raw, /^schema: must be 1/);
});

test('levels: at least one, each with a unique name and a list of checks', () => {
  const none = validRaw();
  none['levels'] = [];
  assertError(none, /^levels: must be a list with at least one level/);

  const duplicate = validRaw();
  duplicate['levels'][1].name = 'G0';
  assertError(duplicate, /^levels\[1\]\.name: "G0" is used by more than one level/);

  const noChecks = validRaw();
  delete noChecks['levels'][1].checks;
  assertError(noChecks, /^levels\[1\]\.checks: must be a list/);
});

test('the first level must run at least one check', () => {
  const raw = validRaw();
  raw['levels'][0].checks = [];
  assertError(raw, /^levels\[0\]\.checks: the first level must have at least one check/);
});

test('checks: a unique name and a non-empty command', () => {
  const duplicate = validRaw();
  duplicate['levels'][1].checks[0].name = 'build';
  assertError(duplicate, /^levels\[1\]\.checks\[0\]\.name: "build" is used by more than one check/);

  const badName = validRaw();
  badName['levels'][0].checks[0].name = 'has spaces';
  assertError(badName, /^levels\[0\]\.checks\[0\]\.name: must be a name/);

  const empty = validRaw();
  empty['levels'][0].checks[0].run = '   ';
  assertError(empty, /^levels\[0\]\.checks\[0\]\.run: must be a non-empty command/);
});

test('a command with a pipe is refused, because a pipe hides the first exit code', () => {
  const piped = validRaw();
  piped['levels'][0].checks[0].run = 'npm run build | tee build.log';
  assertError(piped, /^levels\[0\]\.checks\[0\]\.run: contains a pipe/);

  // "||" is not a pipe: it runs the second command only when the first one failed.
  const orElse = validRaw();
  orElse['levels'][0].checks[0].run = 'npm run build || exit 1';
  parseValid(orElse);
});

test('timeoutMinutes must be a number above 0', () => {
  for (const bad of [0, -5, 'ten', null]) {
    const raw = validRaw();
    raw['levels'][0].checks[0].timeoutMinutes = bad;
    assertError(raw, /^levels\[0\]\.checks\[0\]\.timeoutMinutes: must be a number above 0/);
  }
});

test('expect: patterns must be valid, and the count pattern needs a group', () => {
  const badOutput = validRaw();
  badOutput['levels'][0].checks[1].expect.output = '(unclosed';
  assertError(badOutput, /expect\.output: is not a valid regular expression/);

  const noGroup = validRaw();
  noGroup['levels'][0].checks[1].expect.count.pattern = '\\d+ ran';
  assertError(noGroup, /expect\.count\.pattern: must have a group/);

  const zero = validRaw();
  zero['levels'][0].checks[1].expect.count.atLeast = 0;
  assertError(zero, /expect\.count\.atLeast: must be a whole number, 1 or more/);
});

test('tiers: at least one, no duplicates, and the level must exist', () => {
  const none = validRaw();
  none['tiers'] = [];
  assertError(none, /^tiers: must be a list with at least one branch/);

  const duplicate = validRaw();
  duplicate['tiers'].push({ branch: 'main', level: 'G0' });
  assertError(duplicate, /^tiers\[3\]\.branch: "main" is listed more than once/);

  const typo = validRaw();
  typo['tiers'][0].level = 'g0';
  assertError(typo, /^tiers\[0\]\.level: must be the name of a level \(G0, G1, G2\)/);
});

test('record.maxAgeHours must be a number above 0', () => {
  const raw = validRaw();
  raw['record'].maxAgeHours = 0;
  assertError(raw, /^record\.maxAgeHours: must be a number above 0/);
});

test('every problem is reported, not only the first', () => {
  const raw = validRaw();
  raw['schema'] = 7;
  raw['levels'][0].checks[0].run = '';
  raw['tiers'][0].level = 'nope';
  assert.equal(errorsOf(raw).length, 3);
});

test('the policy id ignores layout and written-out defaults', () => {
  const base = policyId(parseValid(validRaw()));

  const spaced = parsePolicy(JSON.stringify(validRaw(), null, 8));
  assert.ok(spaced.ok);
  assert.equal(policyId(spaced.policy), base);

  const reordered = validRaw();
  const explicitDefault = {
    tiers: reordered['tiers'],
    record: reordered['record'],
    levels: reordered['levels'],
    schema: 1,
  };
  explicitDefault.levels[0].checks[0] = { run: 'npm run build', timeoutMinutes: 30, name: 'build' };
  assert.equal(policyId(parseValid(explicitDefault)), base);

  assert.match(base, /^sha256:[0-9a-f]{64}$/);
});

test('the policy id changes when the meaning changes', () => {
  const base = policyId(parseValid(validRaw()));

  const weakerCommand = validRaw();
  weakerCommand['levels'][0].checks[1].run = 'echo ok';
  assert.notEqual(policyId(parseValid(weakerCommand)), base);

  const droppedExpectation = validRaw();
  delete droppedExpectation['levels'][0].checks[1].expect;
  assert.notEqual(policyId(parseValid(droppedExpectation)), base);

  const lowerTier = validRaw();
  lowerTier['tiers'][2].level = 'G0';
  assert.notEqual(policyId(parseValid(lowerTier)), base);

  const longerLife = validRaw();
  longerLife['record'].maxAgeHours = 9999;
  assert.notEqual(policyId(parseValid(longerLife)), base);
});

// --- protected files ---

test('the list of protected files is optional, and is read with one spelling per file', () => {
  assert.equal(parseValid(validRaw()).protected, undefined);

  const raw = validRaw();
  raw['protected'] = ['ci/build.yml', '.github/workflows/', 'scripts/*.sh'];
  assert.deepEqual(parseValid(raw).protected, ['ci/build.yml', '.github/workflows', 'scripts/*.sh']);
});

test('an empty list of protected files is the same policy as no list', () => {
  const base = policyId(parseValid(validRaw()));
  const empty = validRaw();
  empty['protected'] = [];
  assert.equal(parseValid(empty).protected, undefined);
  assert.equal(policyId(parseValid(empty)), base);
});

test('the policy id changes when a file is put under protection or taken out of it', () => {
  const base = policyId(parseValid(validRaw()));
  const one = validRaw();
  one['protected'] = ['ci/build.yml'];
  const two = validRaw();
  two['protected'] = ['ci/build.yml', 'ci/deploy.yml'];
  assert.notEqual(policyId(parseValid(one)), base);
  assert.notEqual(policyId(parseValid(two)), policyId(parseValid(one)));
});

test('protected: a list of paths from the top of the repository, with forward slashes, each once', () => {
  const refused: [unknown, RegExp][] = [
    ['ci/build.yml', /^protected: must be a list of files/],
    [[7], /^protected\[0\]: must be a file, a folder or a pattern/],
    [[''], /^protected\[0\]: must be a file, a folder or a pattern/],
    [[' ci/build.yml'], /^protected\[0\]: must be a file, a folder or a pattern, with no spaces around it/],
    [['ci\\build.yml'], /^protected\[0\]: use forward slashes/],
    [['/ci/build.yml'], /^protected\[0\]: must be a path from the top of the repository/],
    [['ci/../build.yml'], /^protected\[0\]: must be a path from the top of the repository/],
    [['./ci/build.yml'], /^protected\[0\]: must be a path from the top of the repository/],
    [['ci//build.yml'], /^protected\[0\]: must be a path from the top of the repository/],
    [['/'], /^protected\[0\]: must be a path from the top of the repository/],
    [['ci', 'ci/'], /^protected\[1\]: "ci" is listed more than once/],
  ];
  for (const [value, expected] of refused) {
    const raw = validRaw();
    raw['protected'] = value;
    assertError(raw, expected);
  }
});

test('the policy file is always protected, listed or not', () => {
  assert.deepEqual(protectedPatterns({}), ['gotreceipts.json']);
  assert.deepEqual(protectedPatterns({ protected: ['ci', 'gotreceipts.json'] }), ['gotreceipts.json', 'ci']);
  assert.equal(isProtectedPath({}, 'gotreceipts.json'), true);
  assert.equal(isProtectedPath({}, 'data.txt'), false);
  // Only the one at the top is the policy file.
  assert.equal(isProtectedPath({}, 'examples/gotreceipts.json'), false);
});

test('a protected folder covers everything in it, and * stands for any run of characters', () => {
  const policy = { protected: ['ci/build.yml', '.github/workflows', 'scripts/*.sh'] };
  for (const path of ['ci/build.yml', '.github/workflows/ci.yml', '.github/workflows/deep/er.yml', 'scripts/release.sh', 'scripts/sub/x.sh']) {
    assert.equal(isProtectedPath(policy, path), true, path);
  }
  for (const path of ['ci/build.yml.bak', 'ci/other.yml', '.github/workflows.md', '.github/CODEOWNERS', 'scripts/release.ts', 'my-ci/build.yml']) {
    assert.equal(isProtectedPath(policy, path), false, path);
  }
});

test('a capital letter does not get a file out of protection', () => {
  const policy = { protected: ['ci/build.yml'] };
  assert.equal(isProtectedPath(policy, 'CI/Build.YML'), true);
  assert.equal(isProtectedPath(policy, 'GotReceipts.JSON'), true);
});

test('a name with a dot or a bracket in it is matched as written, not as a pattern', () => {
  const policy = { protected: ['a.b', 'notes (old).txt'] };
  assert.equal(isProtectedPath(policy, 'a.b'), true);
  assert.equal(isProtectedPath(policy, 'axb'), false);
  assert.equal(isProtectedPath(policy, 'notes (old).txt'), true);
});
