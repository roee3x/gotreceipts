import { isObject, type JsonObject } from '../json.ts';
import {
  DEFAULT_APPROVAL_HOURS,
  DEFAULT_MAX_AGE_HOURS,
  DEFAULT_TIMEOUT_MINUTES,
  type Check,
  type Expect,
  type ExpectCount,
  type Level,
  type Policy,
  type Signer,
  type Tier,
} from './policy.ts';

/**
 * The reader of the policy file.
 *
 * It is strict on purpose. An unknown setting, a wrong type or a misspelled level name is an
 * error, never a silent default. A typo in the policy must not quietly weaken the gate.
 * Every problem is reported, not only the first one.
 *
 * Each section of the file has a reader of its own, below, in the order the sections are read.
 */

export type PolicyResult =
  | { readonly ok: true; readonly policy: Policy }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Reports one problem: where in the file it is, and what is wrong there. */
type Fail = (where: string, problem: string) => void;

const SETTINGS = ['schema', 'levels', 'tiers', 'record', 'protected', 'approval', 'travel'];

/** Reads a policy from the text of gotreceipts.json. */
export function parsePolicy(text: string): PolicyResult {
  let raw: unknown;
  try {
    // Some editors on Windows put an invisible mark in front of the text. It is not part of the JSON.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isObject(raw)) return { ok: false, errors: ['the policy must be a JSON object'] };

  const errors: string[] = [];
  const fail: Fail = (where, problem) => {
    errors.push(`${where}: ${problem}`);
  };

  noUnknownKeys(raw, '', SETTINGS, fail);
  if (raw['schema'] !== 1) fail('schema', 'must be 1');

  const levels = readLevels(raw['levels'], fail);

  // The approval is read before the tiers, because a tier may ask for an approval only when
  // someone can give it. When the approval section itself is wrong, a tier is not blamed for
  // it a second time.
  const errorsBeforeApproval = errors.length;
  const approval = readApproval(raw['approval'], fail);
  const approvalIsWrong = errors.length > errorsBeforeApproval;
  const nobodyCanApprove = approval.signers.length === 0 && !approvalIsWrong;

  const tiers = readTiers(raw['tiers'], levels, nobodyCanApprove, fail);
  const maxAgeHours = readRecord(raw['record'], fail);
  const protectedFiles = readProtected(raw['protected'], fail);
  const travel = readTravel(raw['travel'], fail);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      schema: 1,
      levels,
      tiers,
      record: { maxAgeHours },
      // A setting that says nothing is left out, so the policy id is the same as when it is not
      // written at all: an empty list of protected files, no signer, and "travel": false.
      ...(protectedFiles.length > 0 ? { protected: protectedFiles } : {}),
      ...(approval.signers.length > 0 ? { approval } : {}),
      ...(travel ? { travel: true as const } : {}),
    },
  };
}

// --- what several sections share ---

/** Reports every key of `value` that is not in `allowed`. */
function noUnknownKeys(value: JsonObject, where: string, allowed: readonly string[], fail: Fail): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(where === '' ? key : `${where}.${key}`, `unknown setting (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** An object that holds only the settings it may hold. Undefined when it is not an object at all. */
function readObject(value: unknown, where: string, allowed: readonly string[], fail: Fail): JsonObject | undefined {
  if (!isObject(value)) {
    fail(where, 'must be an object');
    return undefined;
  }
  noUnknownKeys(value, where, allowed, fail);
  return value;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The name of a level, a check or a signer. `isTaken` says whether another one already has it. */
function readName(
  value: unknown,
  where: string,
  kind: 'level' | 'check' | 'signer',
  isTaken: (name: string) => boolean,
  fail: Fail,
): string | undefined {
  if (typeof value !== 'string' || !NAME.test(value)) {
    fail(where, 'must be a name made of letters, digits, - and _');
    return undefined;
  }
  if (isTaken(value)) {
    fail(where, `"${value}" is used by more than one ${kind}`);
    return undefined;
  }
  return value;
}

/** A number above 0. `fallback` when nothing is written, and also after a wrong value was reported. */
function readNumberAboveZero(value: unknown, where: string, fallback: number, fail: Fail): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(where, 'must be a number above 0');
    return fallback;
  }
  return value;
}

function isRegularExpression(source: string, where: string, fail: Fail): boolean {
  try {
    new RegExp(source, 'm');
    return true;
  } catch {
    fail(where, 'is not a valid regular expression');
    return false;
  }
}

// --- levels, and the checks of each ---

function readLevels(value: unknown, fail: Fail): Level[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('levels', 'must be a list with at least one level');
    return [];
  }
  const levels: Level[] = [];
  // The name of a check is unique in the whole policy, not only in its level.
  const checkNames = new Set<string>();
  value.forEach((rawLevel: unknown, index) => {
    const level = readLevel(rawLevel, `levels[${index}]`, levels, checkNames, fail);
    if (level !== undefined) levels.push(level);
  });

  // The first level must run something. A level with no checks at all would produce a record that proves nothing.
  const first: unknown = value[0];
  if (isObject(first) && Array.isArray(first['checks']) && first['checks'].length === 0) {
    fail('levels[0].checks', 'the first level must have at least one check');
  }
  return levels;
}

function readLevel(value: unknown, where: string, before: readonly Level[], checkNames: Set<string>, fail: Fail): Level | undefined {
  const raw = readObject(value, where, ['name', 'checks'], fail);
  if (raw === undefined) return undefined;

  const name = readName(raw['name'], `${where}.name`, 'level', (taken) => before.some((level) => level.name === taken), fail);

  const checks: Check[] = [];
  const rawChecks = raw['checks'];
  if (!Array.isArray(rawChecks)) {
    fail(`${where}.checks`, 'must be a list');
  } else {
    rawChecks.forEach((rawCheck: unknown, index) => {
      const check = readCheck(rawCheck, `${where}.checks[${index}]`, checkNames, fail);
      if (check !== undefined) checks.push(check);
    });
  }
  return name === undefined ? undefined : { name, checks };
}

function readCheck(value: unknown, where: string, checkNames: Set<string>, fail: Fail): Check | undefined {
  const raw = readObject(value, where, ['name', 'run', 'timeoutMinutes', 'expect'], fail);
  if (raw === undefined) return undefined;

  const name = readName(raw['name'], `${where}.name`, 'check', (taken) => checkNames.has(taken), fail);
  if (name !== undefined) checkNames.add(name);
  const run = readRun(raw['run'], `${where}.run`, fail);
  const timeoutMinutes = readNumberAboveZero(raw['timeoutMinutes'], `${where}.timeoutMinutes`, DEFAULT_TIMEOUT_MINUTES, fail);
  const expect = readExpect(raw['expect'], `${where}.expect`, fail);

  return name === undefined || run === undefined ? undefined : { name, run, timeoutMinutes, expect };
}

/** A single | that is not part of ||. */
const BARE_PIPE = /(^|[^|])\|([^|]|$)/;

function readRun(value: unknown, where: string, fail: Fail): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(where, 'must be a non-empty command');
    return undefined;
  }
  if (BARE_PIPE.test(value)) {
    fail(where, 'contains a pipe (|). A pipe hides the exit code of the command in front of it. Put the pipeline in a script file and run that');
    return undefined;
  }
  return value;
}

/** What the output of a check must show. Nothing, when nothing is written. */
function readExpect(value: unknown, where: string, fail: Fail): Expect {
  if (value === undefined) return {};
  const raw = readObject(value, where, ['output', 'count'], fail);
  if (raw === undefined) return {};

  const output = readExpectedOutput(raw['output'], `${where}.output`, fail);
  const count = readExpectedCount(raw['count'], `${where}.count`, fail);
  return { ...(output === undefined ? {} : { output }), ...(count === undefined ? {} : { count }) };
}

function readExpectedOutput(value: unknown, where: string, fail: Fail): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    fail(where, 'must be a non-empty string');
    return undefined;
  }
  return isRegularExpression(value, where, fail) ? value : undefined;
}

function readExpectedCount(value: unknown, where: string, fail: Fail): ExpectCount | undefined {
  if (value === undefined) return undefined;
  const raw = readObject(value, where, ['pattern', 'atLeast'], fail);
  if (raw === undefined) return undefined;

  const pattern = readCountPattern(raw['pattern'], `${where}.pattern`, fail);
  const atLeast = raw['atLeast'];
  if (typeof atLeast !== 'number' || !Number.isInteger(atLeast) || atLeast < 1) {
    fail(`${where}.atLeast`, 'must be a whole number, 1 or more');
    return undefined;
  }
  return pattern === undefined ? undefined : { pattern, atLeast };
}

function readCountPattern(value: unknown, where: string, fail: Fail): string | undefined {
  if (typeof value !== 'string' || value === '') {
    fail(where, 'must be a non-empty string');
    return undefined;
  }
  if (!isRegularExpression(value, where, fail)) return undefined;
  // A copy of the pattern with an empty alternative matches the empty text, and so shows how many groups it has.
  const groups = (new RegExp(`${value}|`).exec('')?.length ?? 1) - 1;
  if (groups < 1) {
    fail(where, 'must have a group, in brackets, around the number');
    return undefined;
  }
  return value;
}

// --- approval: who may sign, and for how long a signature counts ---

interface ApprovalSection {
  readonly signers: readonly Signer[];
  readonly maxAgeHours: number;
}

function readApproval(value: unknown, fail: Fail): ApprovalSection {
  const nothing: ApprovalSection = { signers: [], maxAgeHours: DEFAULT_APPROVAL_HOURS };
  if (value === undefined) return nothing;
  const raw = readObject(value, 'approval', ['signers', 'maxAgeHours'], fail);
  if (raw === undefined) return nothing;

  const signers: Signer[] = [];
  const rawSigners = raw['signers'];
  if (!Array.isArray(rawSigners) || rawSigners.length === 0) {
    fail('approval.signers', 'must be a list with at least one signer');
  } else {
    rawSigners.forEach((rawSigner: unknown, index) => {
      const signer = readSigner(rawSigner, `approval.signers[${index}]`, signers, fail);
      if (signer !== undefined) signers.push(signer);
    });
  }
  const maxAgeHours = readNumberAboveZero(raw['maxAgeHours'], 'approval.maxAgeHours', DEFAULT_APPROVAL_HOURS, fail);
  return { signers, maxAgeHours };
}

function readSigner(value: unknown, where: string, before: readonly Signer[], fail: Fail): Signer | undefined {
  const raw = readObject(value, where, ['name', 'key'], fail);
  if (raw === undefined) return undefined;

  const name = readName(raw['name'], `${where}.name`, 'signer', (taken) => before.some((signer) => signer.name === taken), fail);
  const key = readPublicKey(raw['key'], `${where}.key`, before, fail);
  return name === undefined || key === undefined ? undefined : { name, key };
}

/** The key types OpenSSH can sign a file with. The "sk-" types are keys that live on a hardware token. */
const KEY_TYPES =
  '(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\\.com|sk-ecdsa-sha2-nistp256@openssh\\.com)';
/** A public key as it stands in a ".pub" file, without the comment: the type, one space, the body. */
const PUBLIC_KEY = new RegExp(`^${KEY_TYPES} [A-Za-z0-9+/]{32,}={0,3}$`);
const PUBLIC_KEY_WITH_COMMENT = new RegExp(`^${KEY_TYPES} [A-Za-z0-9+/]{32,}={0,3}\\s+\\S`);

function readPublicKey(value: unknown, where: string, before: readonly Signer[], fail: Fail): string | undefined {
  if (typeof value !== 'string' || !PUBLIC_KEY.test(value)) {
    fail(
      where,
      typeof value === 'string' && PUBLIC_KEY_WITH_COMMENT.test(value)
        ? 'leave out the comment at the end of the key. It often holds a user name and the name of a machine'
        : 'must be the public half of an SSH key: its type and its body, such as "ssh-ed25519 AAAA..."',
    );
    return undefined;
  }
  if (before.some((signer) => signer.key === value)) {
    fail(where, 'this key is listed more than once');
    return undefined;
  }
  return value;
}

// --- tiers: which branch needs which level ---

function readTiers(value: unknown, levels: readonly Level[], nobodyCanApprove: boolean, fail: Fail): Tier[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('tiers', 'must be a list with at least one branch');
    return [];
  }
  const levelNames = levels.map((level) => level.name);
  const tiers: Tier[] = [];
  const branches = new Set<string>();
  value.forEach((rawTier: unknown, index) => {
    const tier = readTier(rawTier, `tiers[${index}]`, levelNames, branches, nobodyCanApprove, fail);
    if (tier !== undefined) tiers.push(tier);
  });
  return tiers;
}

function readTier(
  value: unknown,
  where: string,
  levelNames: readonly string[],
  branches: Set<string>,
  nobodyCanApprove: boolean,
  fail: Fail,
): Tier | undefined {
  const raw = readObject(value, where, ['branch', 'level', 'needsApproval'], fail);
  if (raw === undefined) return undefined;

  const needsApproval = readNeedsApproval(raw['needsApproval'], `${where}.needsApproval`, nobodyCanApprove, fail);
  const branch = readBranch(raw['branch'], `${where}.branch`, branches, fail);
  const level = readLevelOfTier(raw['level'], `${where}.level`, levelNames, fail);

  if (needsApproval === undefined || branch === undefined || level === undefined) return undefined;
  // "false" is the same as not written, so it is left out and the policy id stays the same.
  return { branch, level, ...(needsApproval ? { needsApproval: true as const } : {}) };
}

/** Whether the tier asks for an approval. Undefined when what is written is wrong. */
function readNeedsApproval(value: unknown, where: string, nobodyCanApprove: boolean, fail: Fail): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    fail(where, 'must be true or false');
    return undefined;
  }
  if (value === true && nobodyCanApprove) {
    fail(where, 'the policy lists no signer (approval.signers), so nobody could give the approval');
    return undefined;
  }
  return value === true;
}

function readBranch(value: unknown, where: string, branches: Set<string>, fail: Fail): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(where, 'must be a branch name or pattern');
    return undefined;
  }
  if (branches.has(value)) {
    fail(where, `"${value}" is listed more than once`);
    return undefined;
  }
  branches.add(value);
  return value;
}

function readLevelOfTier(value: unknown, where: string, levelNames: readonly string[], fail: Fail): string | undefined {
  if (typeof value !== 'string' || !levelNames.includes(value)) {
    const known = levelNames.join(', ');
    fail(where, `must be the name of a level${known === '' ? '' : ` (${known})`}`);
    return undefined;
  }
  return value;
}

// --- record: for how long a record counts ---

function readRecord(value: unknown, fail: Fail): number {
  if (value === undefined) return DEFAULT_MAX_AGE_HOURS;
  const raw = readObject(value, 'record', ['maxAgeHours'], fail);
  if (raw === undefined) return DEFAULT_MAX_AGE_HOURS;
  return readNumberAboveZero(raw['maxAgeHours'], 'record.maxAgeHours', DEFAULT_MAX_AGE_HOURS, fail);
}

// --- protected files ---

function readProtected(value: unknown, fail: Fail): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail('protected', 'must be a list of files');
    return [];
  }
  const files: string[] = [];
  value.forEach((entry: unknown, index) => {
    const where = `protected[${index}]`;
    if (typeof entry !== 'string' || entry.trim() === '' || entry !== entry.trim()) {
      fail(where, 'must be a file, a folder or a pattern, with no spaces around it');
      return;
    }
    // One spelling per file: counted from the top of the repository, with forward slashes.
    const path = entry.replace(/\/+$/, '');
    if (entry.includes('\\')) {
      fail(where, 'use forward slashes (/), also on Windows');
    } else if (path === '' || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      fail(where, 'must be a path from the top of the repository, such as "ci/build.yml" or ".github/workflows"');
    } else if (files.includes(path)) {
      fail(where, `"${path}" is listed more than once`);
    } else {
      files.push(path);
    }
  });
  return files;
}

// --- travel ---

function readTravel(value: unknown, fail: Fail): boolean {
  if (value !== undefined && typeof value !== 'boolean') fail('travel', 'must be true or false');
  return value === true;
}
