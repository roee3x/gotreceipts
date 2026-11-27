import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { currentBranch, headCommit, headTree, repoRoot, uncommittedChanges } from '../git.ts';
import type { Io } from '../main.ts';
import { knownTarget, policyFor, sourceLines } from '../policy/committed.ts';
import { policyId } from '../policy/hash.ts';
import { checksForLevel, tierForBranch, type Policy } from '../policy/policy.ts';
import { scrubPaths, type GateRecord } from '../record/record.ts';
import { recordLabel, writeRecord } from '../record/store.ts';
import { readVersion } from '../version.ts';
import { runChecks, type CheckResult } from './run-checks.ts';

export const GATE_USAGE = [
  'Usage: gotreceipts gate [options]',
  '',
  'Runs the checks of one gate level on the current commit, one after the other,',
  'and writes a record of the result inside the .git folder of the repository.',
  '',
  'Which level:',
  '  --level <name>    Run this level',
  '  --for <branch>    Run the level a commit needs to enter this branch',
  '  (neither)         Run the level of the branch you are on',
  '',
  'Which policy:',
  '  With --for, or with neither, the policy is the one that is already on that branch, as this',
  '  clone last saw it. What the commit did to its own copy of gotreceipts.json does not count.',
  '  With --level, or for a branch that does not exist yet, it is the policy in the commit itself.',
  '  Only a committed policy is read, never the file in the folder.',
  '',
  'Options:',
  '  -h, --help        Show this help',
  '',
  'The gate refuses to run while there are uncommitted changes, because its result',
  'is a statement about one exact commit.',
  '',
  'Exit codes: 0 = every check passed, 1 = a check failed, 2 = the gate could not run.',
].join('\n');

export interface GateOptions {
  level?: string;
  for?: string;
  help?: boolean;
}

/**
 * The branch the commit is taken to be entering: the one named with --for, else the one that
 * is checked out. With --level no branch is named, so there is none.
 */
export function targetBranch(options: Pick<GateOptions, 'level' | 'for'>, branch: string | undefined): string | undefined {
  if (options.level !== undefined) return undefined;
  return options.for ?? branch;
}

/** Picks the level to run, or explains why none could be picked. */
export function chooseLevel(
  policy: Policy,
  options: Pick<GateOptions, 'level' | 'for'>,
  branch: string | undefined,
): { readonly level: string } | { readonly error: string } {
  const levelNames = policy.levels.map((level) => level.name).join(', ');

  if (options.level !== undefined && options.for !== undefined) {
    return { error: 'give --level or --for, not both' };
  }
  if (options.level !== undefined) {
    if (checksForLevel(policy, options.level) === undefined) {
      return { error: `the policy has no level "${options.level}" (levels: ${levelNames})` };
    }
    return { level: options.level };
  }
  if (options.for !== undefined) {
    const tier = tierForBranch(policy, options.for);
    if (tier === undefined) {
      return { error: `the policy has no tier for the branch "${options.for}"` };
    }
    return { level: tier.level };
  }
  if (branch === undefined) {
    return { error: 'no branch is checked out, so give --level or --for' };
  }
  const tier = tierForBranch(policy, branch);
  if (tier === undefined) {
    return { error: `the policy has no tier for the branch "${branch}", so give --level or --for` };
  }
  return { level: tier.level };
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function resultLine(result: CheckResult, position: number, total: number): string {
  const label = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'SKIPPED';
  const time = result.status === 'skipped' ? '' : `, ${seconds(result.durationMs)}`;
  return `[${position}/${total}] ${result.name}: ${label} (${result.reason}${time})`;
}

export async function gateCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  let options: GateOptions;
  try {
    options = parseArgs({
      args: [...args],
      options: {
        level: { type: 'string' },
        for: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.err(`gotreceipts gate: ${error instanceof Error ? error.message : String(error)}`);
    io.err(GATE_USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (options.help === true) {
    io.out(GATE_USAGE);
    return EXIT.PASS;
  }

  const cannotRun = (reason: string): ExitCode => {
    io.err(`gotreceipts gate: CANNOT RUN: ${reason}`);
    return EXIT.CANNOT_RUN;
  };

  // 1. The exact commit the result will be about.
  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');
  const commit = headCommit(root);
  if (commit === undefined) return cannotRun('the repository has no commit yet');
  const tree = headTree(root);
  if (tree === undefined) return cannotRun('git could not read the commit');
  const branch = currentBranch(root);

  // 2. A clean folder. With loose changes, "this commit passed" would not be true.
  const changes = uncommittedChanges(root);
  if (changes === undefined) return cannotRun('git could not report the state of the folder');
  if (changes.length > 0) {
    io.err('gotreceipts gate: CANNOT RUN: there are uncommitted changes.');
    io.err('The result of a gate is a statement about one exact commit. Commit or stash first.');
    for (const change of changes.slice(0, 10)) io.err(`  ${change}`);
    if (changes.length > 10) io.err(`  ... and ${changes.length - 10} more`);
    return EXIT.CANNOT_RUN;
  }

  // 3. The policy: the one on the branch the commit wants to enter, not the commit's own copy.
  const target = targetBranch(options, branch);
  const picked = policyFor(root, commit, target === undefined ? undefined : knownTarget(root, target));
  if (!picked.ok) {
    for (const error of picked.errors) io.err(`gotreceipts gate: CANNOT RUN: ${error}`);
    return EXIT.CANNOT_RUN;
  }
  const { policy } = picked;

  // 4. The level.
  const chosen = chooseLevel(policy, options, branch);
  if ('error' in chosen) return cannotRun(chosen.error);
  const checks = checksForLevel(policy, chosen.level) ?? [];

  // 5. Say what will run before running it. A check that silently goes missing is then visible.
  const id = policyId(policy);
  const shortCommit = commit.slice(0, 7);
  const [policyLine = '', ...policyNotes] = sourceLines(picked.source);
  io.out(`gotreceipts gate: level ${chosen.level} on commit ${shortCommit}${branch === undefined ? '' : ` (branch ${branch})`}`);
  io.out(`Policy: ${policyLine}`);
  for (const note of policyNotes) io.out(`        ${note}`);
  io.out(`Policy id: ${id}`);
  io.out(`${checks.length} checks to run: ${checks.map((check) => check.name).join(', ')}`);

  const startedAt = new Date().toISOString();
  const results = await runChecks(checks, root, {
    onStart: (check, position, total) => {
      io.out('');
      io.out(`[${position}/${total}] ${check.name}: ${check.run}`);
    },
    onOutput: (chunk) => {
      process.stdout.write(chunk);
    },
    onResult: (result, position, total) => {
      io.out(resultLine(result, position, total));
    },
  });
  const finishedAt = new Date().toISOString();

  // 6. The checks must not have changed what they checked.
  const after = uncommittedChanges(root);
  const movedHead = headCommit(root) !== commit;
  const changedTree = after === undefined || after.length > 0;
  const changedDuringRun = movedHead || changedTree;
  const allPassed = results.length === checks.length && results.every((result) => result.status === 'pass');

  let reason: string;
  if (changedDuringRun) {
    reason = 'the commit or the files changed while the gate was running';
  } else if (!allPassed) {
    const failed = results.find((result) => result.status === 'fail');
    reason = failed === undefined ? 'not every check passed' : `the check "${failed.name}" failed: ${failed.reason}`;
  } else {
    reason = `all ${results.length} checks passed`;
  }
  const passed = allPassed && !changedDuringRun;

  // 7. The receipt. It is written for a failed run too: a failure is also something that happened.
  const paths = { root, home: homedir() };
  const record: GateRecord = {
    schema: 1,
    tool: { name: 'gotreceipts', version: readVersion() },
    commit,
    tree,
    branch: branch ?? null,
    level: chosen.level,
    policyId: id,
    result: passed ? 'pass' : 'fail',
    reason: scrubPaths(reason, paths),
    startedAt,
    finishedAt,
    checks: results.map((result) => ({
      ...result,
      command: scrubPaths(result.command, paths),
      reason: scrubPaths(result.reason, paths),
    })),
    platform: { os: process.platform, arch: process.arch, node: process.version },
  };
  const written = writeRecord(root, record);

  io.out('');
  if (changedDuringRun) {
    io.out('The commit or the files changed while the gate was running, so the result does not describe one commit.');
    for (const change of (after ?? []).slice(0, 10)) io.out(`  ${change}`);
  }
  if (!written) {
    // No receipt, no pass: a run that left no record is not a passed gate.
    io.err('gotreceipts gate: CANNOT RUN: the record could not be written, so this run has no receipt.');
    return EXIT.CANNOT_RUN;
  }
  io.out(`Record: ${recordLabel(record)}`);
  io.out(`VERDICT: ${passed ? 'PASS' : 'FAIL'} (level ${chosen.level}, commit ${shortCommit})`);
  return passed ? EXIT.PASS : EXIT.REFUSED;
}
