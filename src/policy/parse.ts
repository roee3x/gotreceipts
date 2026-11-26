import {
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_TIMEOUT_MINUTES,
  type Check,
  type Expect,
  type Level,
  type Policy,
  type Tier,
} from './policy.ts';

export type PolicyResult =
  | { readonly ok: true; readonly policy: Policy }
  | { readonly ok: false; readonly errors: readonly string[] };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A single | that is not part of ||. */
const BARE_PIPE = /(^|[^|])\|([^|]|$)/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a policy from the text of gotreceipts.json.
 *
 * The reader is strict on purpose. An unknown key, a wrong type or a misspelled level name
 * is an error, never a silent default. A typo in the policy must not quietly weaken the gate.
 * Every problem is reported, not only the first one.
 */
export function parsePolicy(text: string): PolicyResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const errors: string[] = [];
  const fail = (where: string, problem: string): void => {
    errors.push(`${where}: ${problem}`);
  };

  /** Reports every key of `value` that is not in `allowed`. */
  const noUnknownKeys = (value: Json, where: string, allowed: readonly string[]): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        fail(where === '' ? key : `${where}.${key}`, `unknown setting (allowed: ${allowed.join(', ')})`);
      }
    }
  };

  const validRegExp = (source: string, where: string): RegExp | undefined => {
    try {
      return new RegExp(source, 'm');
    } catch {
      fail(where, 'is not a valid regular expression');
      return undefined;
    }
  };

  if (!isObject(raw)) {
    return { ok: false, errors: ['the policy must be a JSON object'] };
  }
  noUnknownKeys(raw, '', ['schema', 'levels', 'tiers', 'record']);

  if (raw['schema'] !== 1) {
    fail('schema', 'must be 1');
  }

  // --- levels and their checks ---
  const levels: Level[] = [];
  const levelNames = new Set<string>();
  const checkNames = new Set<string>();

  const readExpect = (value: unknown, where: string): Expect => {
    if (value === undefined) return {};
    if (!isObject(value)) {
      fail(where, 'must be an object');
      return {};
    }
    noUnknownKeys(value, where, ['output', 'count']);
    const expect: { output?: string; count?: { pattern: string; atLeast: number } } = {};

    const output = value['output'];
    if (output !== undefined) {
      if (typeof output !== 'string' || output === '') {
        fail(`${where}.output`, 'must be a non-empty string');
      } else if (validRegExp(output, `${where}.output`) !== undefined) {
        expect.output = output;
      }
    }

    const count = value['count'];
    if (count !== undefined) {
      if (!isObject(count)) {
        fail(`${where}.count`, 'must be an object');
      } else {
        noUnknownKeys(count, `${where}.count`, ['pattern', 'atLeast']);
        const pattern = count['pattern'];
        const atLeast = count['atLeast'];
        let patternOk = false;
        if (typeof pattern !== 'string' || pattern === '') {
          fail(`${where}.count.pattern`, 'must be a non-empty string');
        } else {
          const compiled = validRegExp(pattern, `${where}.count.pattern`);
          if (compiled !== undefined) {
            // An empty-alternative copy of the pattern matches the empty string and so reveals how many groups it has.
            const groups = (new RegExp(`${pattern}|`).exec('')?.length ?? 1) - 1;
            if (groups < 1) {
              fail(`${where}.count.pattern`, 'must have a group, in brackets, around the number');
            } else {
              patternOk = true;
            }
          }
        }
        const atLeastOk = typeof atLeast === 'number' && Number.isInteger(atLeast) && atLeast >= 1;
        if (!atLeastOk) {
          fail(`${where}.count.atLeast`, 'must be a whole number, 1 or more');
        }
        if (patternOk && atLeastOk) {
          expect.count = { pattern: pattern as string, atLeast: atLeast as number };
        }
      }
    }
    return expect;
  };

  const readCheck = (value: unknown, where: string): Check | undefined => {
    if (!isObject(value)) {
      fail(where, 'must be an object');
      return undefined;
    }
    noUnknownKeys(value, where, ['name', 'run', 'timeoutMinutes', 'expect']);

    const name = value['name'];
    let nameOk = false;
    if (typeof name !== 'string' || !NAME.test(name)) {
      fail(`${where}.name`, 'must be a name made of letters, digits, - and _');
    } else if (checkNames.has(name)) {
      fail(`${where}.name`, `"${name}" is used by more than one check`);
    } else {
      checkNames.add(name);
      nameOk = true;
    }

    const run = value['run'];
    let runOk = false;
    if (typeof run !== 'string' || run.trim() === '') {
      fail(`${where}.run`, 'must be a non-empty command');
    } else if (BARE_PIPE.test(run)) {
      fail(
        `${where}.run`,
        'contains a pipe (|). A pipe hides the exit code of the command in front of it. Put the pipeline in a script file and run that',
      );
    } else {
      runOk = true;
    }

    const timeout = value['timeoutMinutes'];
    let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        fail(`${where}.timeoutMinutes`, 'must be a number above 0');
      } else {
        timeoutMinutes = timeout;
      }
    }

    const expect = readExpect(value['expect'], `${where}.expect`);

    if (!nameOk || !runOk) return undefined;
    return { name: name as string, run: run as string, timeoutMinutes, expect };
  };

  const rawLevels = raw['levels'];
  if (!Array.isArray(rawLevels) || rawLevels.length === 0) {
    fail('levels', 'must be a list with at least one level');
  } else {
    rawLevels.forEach((rawLevel: unknown, levelIndex) => {
      const where = `levels[${levelIndex}]`;
      if (!isObject(rawLevel)) {
        fail(where, 'must be an object');
        return;
      }
      noUnknownKeys(rawLevel, where, ['name', 'checks']);

      const name = rawLevel['name'];
      let levelName: string | undefined;
      if (typeof name !== 'string' || !NAME.test(name)) {
        fail(`${where}.name`, 'must be a name made of letters, digits, - and _');
      } else if (levelNames.has(name)) {
        fail(`${where}.name`, `"${name}" is used by more than one level`);
      } else {
        levelNames.add(name);
        levelName = name;
      }

      const checks: Check[] = [];
      const rawChecks = rawLevel['checks'];
      if (!Array.isArray(rawChecks)) {
        fail(`${where}.checks`, 'must be a list');
      } else {
        rawChecks.forEach((rawCheck: unknown, checkIndex) => {
          const check = readCheck(rawCheck, `${where}.checks[${checkIndex}]`);
          if (check !== undefined) checks.push(check);
        });
      }

      if (levelName !== undefined) levels.push({ name: levelName, checks });
    });

    // The first level must run something. A level with no checks at all would produce a record that proves nothing.
    const first = rawLevels[0];
    if (isObject(first) && Array.isArray(first['checks']) && first['checks'].length === 0) {
      fail('levels[0].checks', 'the first level must have at least one check');
    }
  }

  // --- tiers ---
  const tiers: Tier[] = [];
  const rawTiers = raw['tiers'];
  if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
    fail('tiers', 'must be a list with at least one branch');
  } else {
    const seen = new Set<string>();
    rawTiers.forEach((rawTier: unknown, tierIndex) => {
      const where = `tiers[${tierIndex}]`;
      if (!isObject(rawTier)) {
        fail(where, 'must be an object');
        return;
      }
      noUnknownKeys(rawTier, where, ['branch', 'level']);

      const branch = rawTier['branch'];
      const level = rawTier['level'];
      let ok = true;
      if (typeof branch !== 'string' || branch.trim() === '') {
        fail(`${where}.branch`, 'must be a branch name or pattern');
        ok = false;
      } else if (seen.has(branch)) {
        fail(`${where}.branch`, `"${branch}" is listed more than once`);
        ok = false;
      } else {
        seen.add(branch);
      }
      if (typeof level !== 'string' || !levelNames.has(level)) {
        const known = [...levelNames].join(', ');
        fail(`${where}.level`, `must be the name of a level${known === '' ? '' : ` (${known})`}`);
        ok = false;
      }
      if (ok) tiers.push({ branch: branch as string, level: level as string });
    });
  }

  // --- record ---
  let maxAgeHours = DEFAULT_MAX_AGE_HOURS;
  const rawRecord = raw['record'];
  if (rawRecord !== undefined) {
    if (!isObject(rawRecord)) {
      fail('record', 'must be an object');
    } else {
      noUnknownKeys(rawRecord, 'record', ['maxAgeHours']);
      const value = rawRecord['maxAgeHours'];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          fail('record.maxAgeHours', 'must be a number above 0');
        } else {
          maxAgeHours = value;
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, policy: { schema: 1, levels, tiers, record: { maxAgeHours } } };
}
