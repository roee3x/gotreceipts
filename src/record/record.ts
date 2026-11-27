import { UTC_TIME } from '../clock.ts';
import type { CheckResult, CheckStatus } from '../gate/run-checks.ts';
import { isFullId } from '../git.ts';
import { isObject } from '../json.ts';

/**
 * The record of one gate run: the receipt.
 *
 * It says which commit was checked, at which level, under which policy, what every check did,
 * and whether the whole run passed. It is safe to show: it holds no folder path of the machine
 * it was made on, no machine name and no user name.
 */
export interface GateRecord {
  readonly schema: 1;
  readonly tool: { readonly name: 'gotreceipts'; readonly version: string };
  /** The full id of the commit the checks ran on. */
  readonly commit: string;
  /** The id of that commit's file tree. */
  readonly tree: string;
  /** The branch that was checked out, or null when none was. */
  readonly branch: string | null;
  readonly level: string;
  /** The id of the policy the run was made under. */
  readonly policyId: string;
  readonly result: 'pass' | 'fail';
  /** One sentence that explains the result. */
  readonly reason: string;
  /** Times are in UTC, in the form 2026-01-31T12:00:00.000Z. */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: readonly CheckResult[];
  readonly platform: { readonly os: string; readonly arch: string; readonly node: string };
}

export type RecordParse =
  | { readonly ok: true; readonly record: GateRecord }
  | { readonly ok: false; readonly error: string };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the machine's folder paths from a text.
 * Both slash directions are replaced, in any upper or lower case.
 */
export function scrubPaths(text: string, paths: { readonly root: string; readonly home: string }): string {
  let scrubbed = text;
  const replace = (path: string, label: string): void => {
    if (path.length < 3) return;
    const forward = path.replace(/\\/g, '/');
    const backward = path.replace(/\//g, '\\');
    for (const variant of new Set([path, forward, backward])) {
      scrubbed = scrubbed.replace(new RegExp(escapeRegExp(variant), 'gi'), label);
    }
  };
  // The repository usually sits inside the home folder, so it is replaced first.
  replace(paths.root, '<repo>');
  replace(paths.home, '<home>');
  return scrubbed;
}

const STATUSES: readonly CheckStatus[] = ['pass', 'fail', 'skipped'];

function isCheckResult(value: unknown): value is CheckResult {
  if (!isObject(value)) return false;
  return (
    typeof value['name'] === 'string' &&
    typeof value['command'] === 'string' &&
    STATUSES.includes(value['status'] as CheckStatus) &&
    (value['exitCode'] === null || typeof value['exitCode'] === 'number') &&
    typeof value['timedOut'] === 'boolean' &&
    typeof value['durationMs'] === 'number' &&
    typeof value['reason'] === 'string'
  );
}

/**
 * Reads a record back from its file text.
 *
 * Strict, like the policy reader. A record with a missing or malformed field is not a record.
 * It also has to agree with itself: "pass" is only accepted when every check in it passed.
 */
export function parseRecord(text: string): RecordParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (!isObject(raw)) return { ok: false, error: 'not a JSON object' };

  const bad = (field: string): RecordParse => ({ ok: false, error: `the field "${field}" is missing or malformed` });

  if (raw['schema'] !== 1) return bad('schema');
  const tool = raw['tool'];
  if (!isObject(tool) || tool['name'] !== 'gotreceipts' || typeof tool['version'] !== 'string') return bad('tool');
  if (typeof raw['commit'] !== 'string' || !isFullId(raw['commit'])) return bad('commit');
  if (typeof raw['tree'] !== 'string' || !isFullId(raw['tree'])) return bad('tree');
  if (raw['branch'] !== null && typeof raw['branch'] !== 'string') return bad('branch');
  if (typeof raw['level'] !== 'string' || raw['level'] === '') return bad('level');
  if (typeof raw['policyId'] !== 'string' || !raw['policyId'].startsWith('sha256:')) return bad('policyId');
  if (raw['result'] !== 'pass' && raw['result'] !== 'fail') return bad('result');
  if (typeof raw['reason'] !== 'string') return bad('reason');
  if (typeof raw['startedAt'] !== 'string' || !UTC_TIME.test(raw['startedAt'])) return bad('startedAt');
  if (typeof raw['finishedAt'] !== 'string' || !UTC_TIME.test(raw['finishedAt'])) return bad('finishedAt');
  if (Number.isNaN(Date.parse(raw['startedAt'])) || Number.isNaN(Date.parse(raw['finishedAt']))) return bad('finishedAt');
  const checks = raw['checks'];
  if (!Array.isArray(checks) || !checks.every(isCheckResult)) return bad('checks');
  const platform = raw['platform'];
  if (
    !isObject(platform) ||
    typeof platform['os'] !== 'string' ||
    typeof platform['arch'] !== 'string' ||
    typeof platform['node'] !== 'string'
  ) {
    return bad('platform');
  }

  if (raw['result'] === 'pass') {
    if (checks.length === 0) return { ok: false, error: 'it says "pass" but lists no checks' };
    if (!checks.every((check) => check.status === 'pass')) {
      return { ok: false, error: 'it says "pass" but not every check in it passed' };
    }
  }

  return { ok: true, record: raw as unknown as GateRecord };
}
