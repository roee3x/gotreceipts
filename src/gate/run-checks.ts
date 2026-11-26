import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { Check } from '../policy/policy.ts';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

/** What happened to one check. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly status: CheckStatus;
  /** The exit code, or null when the check was killed or never started. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** One short sentence that explains the status. */
  readonly reason: string;
}

/** How much output is kept for the expectations. Older output is dropped. */
const MAX_KEPT_OUTPUT = 5_000_000;

/**
 * Decides whether the output of a check shows what the policy says it must show.
 * Returns undefined when it does, or the reason when it does not.
 *
 * Exit code 0 alone is not trusted. A test command can exit 0 after running nothing.
 */
export function unmetExpectation(check: Check, output: string): string | undefined {
  const { expect } = check;

  if (expect.output !== undefined && !new RegExp(expect.output, 'm').test(output)) {
    return `the output does not contain the expected line (${expect.output})`;
  }

  if (expect.count !== undefined) {
    const matches = [...output.matchAll(new RegExp(expect.count.pattern, 'gm'))];
    const last = matches.at(-1);
    if (last === undefined) {
      return `the output does not show the expected count (${expect.count.pattern})`;
    }
    const value = Number(last[1]);
    if (!Number.isFinite(value)) {
      return `the expected count is not a number ("${last[1] ?? ''}")`;
    }
    if (value < expect.count.atLeast) {
      return `the output shows a count of ${value}, and at least ${expect.count.atLeast} is needed`;
    }
  }

  return undefined;
}

/** Stops a check and everything it started. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    // The check was started as the leader of its own process group, so this reaches its children too.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Runs one check as its own process and waits for it.
 *
 * The command runs through the system shell, exactly as written in the policy.
 * Its exit code is read directly from the process. Nothing sits between the check and the gate.
 */
export function runCheck(check: Check, cwd: string, onOutput: (chunk: string) => void): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let settled = false;

    const finish = (status: CheckStatus, exitCode: number | null, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: check.name,
        command: check.run,
        status,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        reason,
      });
    };

    const child = spawn(check.run, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, check.timeoutMinutes * 60_000);

    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-MAX_KEPT_OUTPUT);
      onOutput(chunk);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);

    child.on('error', (error) => {
      finish('fail', null, `the command could not be started: ${error.message}`);
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish('fail', code, `timed out after ${check.timeoutMinutes} minutes`);
      } else if (code === null) {
        finish('fail', null, 'the command was killed before it finished');
      } else if (code !== 0) {
        finish('fail', code, `exit code ${code}`);
      } else {
        const unmet = unmetExpectation(check, output);
        if (unmet === undefined) {
          finish('pass', 0, 'exit code 0');
        } else {
          finish('fail', 0, `exit code 0, but ${unmet}`);
        }
      }
    });
  });
}

export interface RunHooks {
  /** Called just before a check starts. `position` starts at 1. */
  onStart(check: Check, position: number, total: number): void;
  /** Called with everything a check prints, as it prints it. */
  onOutput(chunk: string): void;
  /** Called when a check has a result, including a check that was skipped. */
  onResult(result: CheckResult, position: number, total: number): void;
}

/**
 * Runs the checks in order and stops running at the first failure.
 *
 * Every check gets a result. A check that did not run is reported as skipped, never left out,
 * so the list of results always has as many entries as the list of checks.
 */
export async function runChecks(checks: readonly Check[], cwd: string, hooks: RunHooks): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let failed = false;

  for (const [index, check] of checks.entries()) {
    const position = index + 1;
    let result: CheckResult;
    if (failed) {
      result = {
        name: check.name,
        command: check.run,
        status: 'skipped',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        reason: 'an earlier check failed',
      };
    } else {
      hooks.onStart(check, position, checks.length);
      result = await runCheck(check, cwd, hooks.onOutput);
      if (result.status !== 'pass') failed = true;
    }
    results.push(result);
    hooks.onResult(result, position, checks.length);
  }

  return results;
}
