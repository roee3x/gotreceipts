import { EXIT, type ExitCode } from '../exit-codes.ts';
import { repoRoot, shortId } from '../git.ts';
import type { Io } from '../main.ts';
import { readOptions } from '../options.ts';
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

/** The longest of some names, so that what follows them can be lined up. */
function widthOf(names: readonly string[]): number {
  return Math.max(...names.map((name) => name.length));
}

function levelLines(policy: Policy): string[] {
  const width = widthOf(policy.levels.map((level) => level.name));
  return [
    'Levels (each level also runs every check of the levels above it in this list)',
    ...policy.levels.map((level) => {
      const checks = checksForLevel(policy, level.name) ?? [];
      return `  ${level.name.padEnd(width)}  ${checks.length} checks: ${checks.map((check) => check.name).join(', ')}`;
    }),
  ];
}

function branchLines(policy: Policy): string[] {
  const width = widthOf(policy.tiers.map((tier) => tier.branch));
  return [
    'Branches (the level a commit needs before it may enter the branch)',
    ...policy.tiers.map((tier) => `  ${tier.branch.padEnd(width)}  ${tier.level}${tier.needsApproval === true ? ', and a signed approval' : ''}`),
  ];
}

function protectedLines(policy: Policy): string[] {
  return [
    'Protected files (a change to one of these is a change to the gate itself)',
    ...protectedPatterns(policy).map((pattern) => `  ${pattern}${pattern === POLICY_FILE_NAME ? '   (always, listed or not)' : ''}`),
  ];
}

function approvalLines(policy: Policy): string[] {
  if (policy.approval === undefined) {
    return [
      'Approval: NOT LOCKED. The policy lists no signer, so nothing asks for a signature:',
      '  a change to a protected file, the policy file included, gets in like any other change.',
    ];
  }
  return [
    'Approval (a signature that only an owner can make)',
    `  signers: ${policy.approval.signers.map((signer) => signer.name).join(', ')}`,
    '  asked for: a change to a protected file, on every branch with a level',
    ...policy.tiers.filter((tier) => tier.needsApproval === true).map((tier) => `  asked for: every commit that enters ${tier.branch}`),
    `  an approval counts for ${policy.approval.maxAgeHours} hours, for one commit and one branch`,
  ];
}

function closingLines(policy: Policy): string[] {
  return [
    `A record counts for ${policy.record.maxAgeHours} hours.`,
    policy.travel === true
      ? 'Records and approvals travel: a push, "approve" and "merge" send them to the remote, and "merge" asks the remote for them.'
      : 'Records and approvals stay in this clone, unless someone runs "gotreceipts send".',
  ];
}

/** Shows what the gate will do under a policy: one block per section, with an empty line between them. */
function describe(io: Io, policy: Policy): void {
  const blocks = [[`Policy id: ${policyId(policy)}`], levelLines(policy), branchLines(policy), protectedLines(policy), approvalLines(policy), closingLines(policy)];
  for (const [index, block] of blocks.entries()) {
    if (index > 0) io.out('');
    for (const line of block) io.out(line);
  }
}

export async function policyCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'policy', usage: POLICY_USAGE, values: ['file', 'for'] }, args, io);
  if (start.done) return start.code;
  const { options, cannotRun } = start;

  if (options.file !== undefined && options.for !== undefined) return cannotRun('give --file or --for, not both');

  // The policy that is already on a branch: the one a commit entering it is judged by.
  if (options.for !== undefined) {
    const root = repoRoot(process.cwd());
    if (root === undefined) return cannotRun('this folder is not inside a git repository');
    const target = knownTarget(root, options.for);
    if (target.commit === undefined) return cannotRun(`this clone knows no branch "${options.for}"`);
    const committed = policyInCommit(root, target.commit);
    if (committed.kind === 'none') return cannotRun(`${target.shown} holds no policy file (${POLICY_FILE_NAME})`);
    if (committed.kind === 'invalid') {
      return cannotRun(...committed.errors.map((error) => `the policy on ${target.shown} is not valid: ${POLICY_FILE_NAME}: ${error}`));
    }
    io.out(`The policy on ${target.shown}, at commit ${shortId(target.commit)}, is valid.`);
    io.out(`A commit that wants to enter "${options.for}" is judged by it.`);
    describe(io, committed.policy);
    return EXIT.PASS;
  }

  // The policy file in the folder, or the one that was named.
  const loaded = loadPolicy(process.cwd(), options.file);
  if (!loaded.ok) return cannotRun(...loaded.errors);

  io.out('The policy is valid.');
  describe(io, loaded.policy);
  return EXIT.PASS;
}
