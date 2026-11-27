import { homedir } from 'node:os';

import { approvalOf, rulesFor } from '../door/judge.ts';
import { approvalLines, policyWords } from '../door/report.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { currentBranch, headCommit, repoRoot, shortId, treeOf, uncommittedChanges } from '../git.ts';
import type { Io } from '../main.ts';
import { readOptions } from '../options.ts';
import { knownTarget } from '../policy/committed.ts';
import { policyId } from '../policy/hash.ts';
import { chooseLevel, targetBranch } from '../policy/level.ts';
import { checksForLevel, type Check } from '../policy/policy.ts';
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

/** How many changed files are written out before the rest is only counted. */
const CHANGES_SHOWN = 10;

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function resultLine(result: CheckResult, position: number, total: number): string {
  const label = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'SKIPPED';
  const time = result.status === 'skipped' ? '' : `, ${seconds(result.durationMs)}`;
  return `[${position}/${total}] ${result.name}: ${label} (${result.reason}${time})`;
}

/** What a run came to: whether it passed, and one sentence that says why. */
interface Outcome {
  readonly passed: boolean;
  readonly reason: string;
}

/**
 * Sums a run up. It passed when every check of the level ran and passed, and the checks
 * did not change what they were checking.
 */
function outcomeOf(checks: readonly Check[], results: readonly CheckResult[], changedDuringRun: boolean): Outcome {
  if (changedDuringRun) return { passed: false, reason: 'the commit or the files changed while the gate was running' };

  const allPassed = results.length === checks.length && results.every((result) => result.status === 'pass');
  if (allPassed) return { passed: true, reason: `all ${results.length} checks passed` };

  const failed = results.find((result) => result.status === 'fail');
  return { passed: false, reason: failed === undefined ? 'not every check passed' : `the check "${failed.name}" failed: ${failed.reason}` };
}

/** What a run was about, and when it ran. */
interface Run {
  readonly root: string;
  readonly commit: string;
  readonly tree: string;
  readonly branch: string | undefined;
  readonly level: string;
  readonly policyId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * The record of a run. The folders of this machine are taken out of everything a check said,
 * so a record can be shown to anyone.
 */
function recordOf(run: Run, results: readonly CheckResult[], outcome: Outcome): GateRecord {
  const paths = { root: run.root, home: homedir() };
  return {
    schema: 1,
    tool: { name: 'gotreceipts', version: readVersion() },
    commit: run.commit,
    tree: run.tree,
    branch: run.branch ?? null,
    level: run.level,
    policyId: run.policyId,
    result: outcome.passed ? 'pass' : 'fail',
    reason: scrubPaths(outcome.reason, paths),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    checks: results.map((result) => ({
      ...result,
      command: scrubPaths(result.command, paths),
      reason: scrubPaths(result.reason, paths),
    })),
    platform: { os: process.platform, arch: process.arch, node: process.version },
  };
}

export async function gateCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'gate', usage: GATE_USAGE, values: ['level', 'for'] }, args, io);
  if (start.done) return start.code;
  const { options, cannotRun } = start;

  // 1. The exact commit the result will be about.
  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');
  const commit = headCommit(root);
  if (commit === undefined) return cannotRun('the repository has no commit yet');
  const tree = treeOf(root, commit);
  if (tree === undefined) return cannotRun('git could not read the commit');
  const checkedOut = currentBranch(root);

  // 2. A clean folder. With loose changes, "this commit passed" would not be true.
  const changes = uncommittedChanges(root);
  if (changes === undefined) return cannotRun('git could not report the state of the folder');
  if (changes.length > 0) {
    io.err('gotreceipts gate: CANNOT RUN: there are uncommitted changes.');
    io.err('The result of a gate is a statement about one exact commit. Commit or stash first.');
    for (const change of changes.slice(0, CHANGES_SHOWN)) io.err(`  ${change}`);
    if (changes.length > CHANGES_SHOWN) io.err(`  ... and ${changes.length - CHANGES_SHOWN} more`);
    return EXIT.CANNOT_RUN;
  }

  // 3. The policy: the one on the branch the commit wants to enter, not the commit's own copy.
  const branch = targetBranch(options, checkedOut);
  const rules = rulesFor(root, commit, branch === undefined ? undefined : knownTarget(root, branch));
  if (!rules.ok) return cannotRun(...rules.errors);
  const { policy } = rules;

  // 4. The level, and with it the checks.
  const chosen = chooseLevel(policy, options, checkedOut);
  if ('error' in chosen) return cannotRun(chosen.error);
  const { level } = chosen;
  const checks = checksForLevel(policy, level) ?? [];

  // 5. Say what will run before running it. A check that silently goes missing is then visible.
  const id = policyId(policy);
  const shortCommit = shortId(commit);
  const { which, notes } = policyWords(rules.source);
  // The gate runs the checks and asks for no approval. It only says, early, when the commit
  // will need one at the door.
  const early = approvalLines(approvalOf(root, rules, { commit, branch, now: Date.now() }));
  io.out(`gotreceipts gate: level ${level} on commit ${shortCommit}${checkedOut === undefined ? '' : ` (branch ${checkedOut})`}`);
  io.out(`Policy: ${which}`);
  for (const line of [...notes, ...early]) io.out(`        ${line}`);
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
  const changedDuringRun = headCommit(root) !== commit || after === undefined || after.length > 0;
  const outcome = outcomeOf(checks, results, changedDuringRun);

  // 7. The receipt. It is written for a failed run too: a failure is also something that happened.
  const record = recordOf({ root, commit, tree, branch: checkedOut, level, policyId: id, startedAt, finishedAt }, results, outcome);
  const written = writeRecord(root, record);

  io.out('');
  if (changedDuringRun) {
    io.out('The commit or the files changed while the gate was running, so the result does not describe one commit.');
    for (const change of (after ?? []).slice(0, CHANGES_SHOWN)) io.out(`  ${change}`);
  }
  if (!written) {
    // No receipt, no pass: a run that left no record is not a passed gate.
    io.err('gotreceipts gate: CANNOT RUN: the record could not be written, so this run has no receipt.');
    return EXIT.CANNOT_RUN;
  }
  io.out(`Record: ${recordLabel(record)}`);
  io.out(`VERDICT: ${outcome.passed ? 'PASS' : 'FAIL'} (level ${level}, commit ${shortCommit})`);
  return outcome.passed ? EXIT.PASS : EXIT.REFUSED;
}
