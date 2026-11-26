import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { currentBranch, headCommit, uncommittedChanges } from '../git.ts';
import type { Io } from '../main.ts';
import { policyId } from '../policy/hash.ts';
import { loadPolicy } from '../policy/load.ts';
import { checksForLevel, tierForBranch, type Policy } from '../policy/policy.ts';
import { runChecks, type CheckResult } from './run-checks.ts';

export const GATE_USAGE = [
  'Usage: gotreceipts gate [options]',
  '',
  'Runs the checks of one gate level on the current commit, one after the other.',
  '',
  'Which level:',
  '  --level <name>    Run this level',
  '  --for <branch>    Run the level a commit needs to enter this branch',
  '  (neither)         Run the level of the branch you are on',
  '',
  'Options:',
  '  --file <file>     Read this policy file instead of gotreceipts.json at the top of the repository',
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
  file?: string;
  help?: boolean;
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
        file: { type: 'string' },
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

  // 1. The policy.
  const loaded = loadPolicy(process.cwd(), options.file);
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`gotreceipts gate: CANNOT RUN: ${error}`);
    return EXIT.CANNOT_RUN;
  }
  const { policy, root } = loaded;
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  // 2. The exact commit the result will be about.
  const commit = headCommit(root);
  if (commit === undefined) return cannotRun('the repository has no commit yet');
  const branch = currentBranch(root);

  // 3. The level.
  const chosen = chooseLevel(policy, options, branch);
  if ('error' in chosen) return cannotRun(chosen.error);
  const checks = checksForLevel(policy, chosen.level) ?? [];

  // 4. A clean folder. With loose changes, "this commit passed" would not be true.
  const changes = uncommittedChanges(root);
  if (changes === undefined) return cannotRun('git could not report the state of the folder');
  if (changes.length > 0) {
    io.err('gotreceipts gate: CANNOT RUN: there are uncommitted changes.');
    io.err('The result of a gate is a statement about one exact commit. Commit or stash first.');
    for (const change of changes.slice(0, 10)) io.err(`  ${change}`);
    if (changes.length > 10) io.err(`  ... and ${changes.length - 10} more`);
    return EXIT.CANNOT_RUN;
  }

  // 5. Say what will run before running it. A check that silently goes missing is then visible.
  const shortCommit = commit.slice(0, 7);
  io.out(`gotreceipts gate: level ${chosen.level} on commit ${shortCommit}${branch === undefined ? '' : ` (branch ${branch})`}`);
  io.out(`Policy id: ${policyId(policy)}`);
  io.out(`${checks.length} checks to run: ${checks.map((check) => check.name).join(', ')}`);

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

  // 6. The checks must not have changed what they checked.
  const after = uncommittedChanges(root);
  const movedHead = headCommit(root) !== commit;
  const changedTree = after === undefined || after.length > 0;

  io.out('');
  const allPassed = results.length === checks.length && results.every((result) => result.status === 'pass');

  if (movedHead || changedTree) {
    io.out('The commit or the files changed while the gate was running, so the result does not describe one commit.');
    for (const change of (after ?? []).slice(0, 10)) io.out(`  ${change}`);
    io.out(`VERDICT: FAIL (level ${chosen.level}, commit ${shortCommit})`);
    return EXIT.REFUSED;
  }

  if (!allPassed) {
    io.out(`VERDICT: FAIL (level ${chosen.level}, commit ${shortCommit})`);
    return EXIT.REFUSED;
  }

  io.out(`VERDICT: PASS (level ${chosen.level}, commit ${shortCommit})`);
  return EXIT.PASS;
}
