import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { repoRoot } from '../git.ts';
import type { Io } from '../main.ts';
import { knownTarget, policyInCommit } from './committed.ts';
import { policyId } from './hash.ts';
import { loadPolicy } from './load.ts';
import { checksForLevel, POLICY_FILE_NAME, protectedPatterns, type Policy } from './policy.ts';

export const POLICY_USAGE = [
  'Usage: gotreceipts policy [options]',
  '',
  'Reads a policy, checks it, and shows what the gate will do.',
  '',
  'Which policy:',
  '  (no option)     gotreceipts.json in the folder, as it is now. This is how a policy is tried',
  '                  out while it is being written',
  '  --for <branch>  The policy that is already on this branch, as this clone last saw it.',
  '                  A commit that wants to enter the branch is judged by this one',
  '  --file <file>   This policy file',
  '',
  'Options:',
  '  -h, --help      Show this help',
  '',
  'Exit codes: 0 = the policy is valid, 2 = it is missing or has errors.',
].join('\n');

function describe(io: Io, policy: Policy): void {
  const width = (values: readonly string[]): number => Math.max(...values.map((value) => value.length));

  io.out(`Policy id: ${policyId(policy)}`);
  io.out('');

  io.out('Levels (each level also runs every check of the levels above it in this list)');
  const levelWidth = width(policy.levels.map((level) => level.name));
  for (const level of policy.levels) {
    const all = checksForLevel(policy, level.name) ?? [];
    const names = all.map((check) => check.name).join(', ');
    io.out(`  ${level.name.padEnd(levelWidth)}  ${all.length} checks: ${names}`);
  }
  io.out('');

  io.out('Branches (the level a commit needs before it may enter the branch)');
  const branchWidth = width(policy.tiers.map((tier) => tier.branch));
  for (const tier of policy.tiers) {
    io.out(`  ${tier.branch.padEnd(branchWidth)}  ${tier.level}`);
  }
  io.out('');

  io.out('Protected files (a change to one of these is a change to the gate itself)');
  for (const pattern of protectedPatterns(policy)) {
    io.out(`  ${pattern}${pattern === POLICY_FILE_NAME ? '   (always, listed or not)' : ''}`);
  }
  io.out('');

  io.out(`A record counts for ${policy.record.maxAgeHours} hours.`);
}

export async function policyCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  let options: { file?: string; for?: string; help?: boolean };
  try {
    options = parseArgs({
      args: [...args],
      options: { file: { type: 'string' }, for: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.err(`gotreceipts policy: ${error instanceof Error ? error.message : String(error)}`);
    io.err(POLICY_USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (options.help === true) {
    io.out(POLICY_USAGE);
    return EXIT.PASS;
  }

  const cannotRun = (reasons: readonly string[]): ExitCode => {
    for (const reason of reasons) io.err(`gotreceipts policy: CANNOT RUN: ${reason}`);
    return EXIT.CANNOT_RUN;
  };

  if (options.file !== undefined && options.for !== undefined) return cannotRun(['give --file or --for, not both']);

  // The policy that is already on a branch: the one a commit entering it is judged by.
  if (options.for !== undefined) {
    const root = repoRoot(process.cwd());
    if (root === undefined) return cannotRun(['this folder is not inside a git repository']);
    const target = knownTarget(root, options.for);
    if (target.commit === undefined) return cannotRun([`this clone knows no branch "${options.for}"`]);
    const committed = policyInCommit(root, target.commit);
    if (committed.kind === 'none') return cannotRun([`${target.shown} holds no policy file (${POLICY_FILE_NAME})`]);
    if (committed.kind === 'invalid') {
      return cannotRun(committed.errors.map((error) => `the policy on ${target.shown} is not valid: ${POLICY_FILE_NAME}: ${error}`));
    }
    io.out(`The policy on ${target.shown}, at commit ${target.commit.slice(0, 7)}, is valid.`);
    io.out(`A commit that wants to enter "${options.for}" is judged by it.`);
    describe(io, committed.policy);
    return EXIT.PASS;
  }

  const loaded = loadPolicy(process.cwd(), options.file);
  if (!loaded.ok) return cannotRun(loaded.errors);

  io.out('The policy is valid.');
  describe(io, loaded.policy);
  return EXIT.PASS;
}
