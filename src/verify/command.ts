import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { chooseLevel, targetBranch } from '../gate/command.ts';
import { currentBranch, repoRoot, resolveCommit } from '../git.ts';
import type { Io } from '../main.ts';
import { knownTarget, policyFor, sourceLines } from '../policy/committed.ts';
import { shownAge } from './decide.ts';
import { judgeCommit } from './judge.ts';

export const VERIFY_USAGE = [
  'Usage: gotreceipts verify [commit] [options]',
  '',
  'Answers one question: does this commit have a record that satisfies a gate level?',
  'It runs no checks. It only reads the records that "gotreceipts gate" wrote.',
  '',
  'The commit is the one that is checked out, unless another one is named.',
  '',
  'Which level:',
  '  --level <name>    The commit needs this level',
  '  --for <branch>    The commit needs the level of this branch',
  '  (neither)         The commit needs the level of the branch you are on',
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
  'A record satisfies a level when it passed, at that level or a higher one, under that policy,',
  'is still fresh, and no newer run failed a check that the level needs.',
  '',
  'Exit codes: 0 = the commit has such a record, 1 = it does not, 2 = the question could not be answered.',
].join('\n');

export async function verifyCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  let options: { level?: string; for?: string; help?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        level: { type: 'string' },
        for: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
    options = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(`gotreceipts verify: ${error instanceof Error ? error.message : String(error)}`);
    io.err(VERIFY_USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (options.help === true) {
    io.out(VERIFY_USAGE);
    return EXIT.PASS;
  }

  const cannotRun = (reason: string): ExitCode => {
    io.err(`gotreceipts verify: CANNOT RUN: ${reason}`);
    return EXIT.CANNOT_RUN;
  };

  if (positionals.length > 1) return cannotRun('name one commit, not several');

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  const wanted = positionals[0] ?? 'HEAD';
  const commit = resolveCommit(root, wanted);
  if (commit === undefined) {
    return cannotRun(positionals[0] === undefined ? 'the repository has no commit yet' : `there is no commit "${wanted}"`);
  }

  // The policy: the one on the branch the commit wants to enter, not the commit's own copy.
  const branch = currentBranch(root);
  const target = targetBranch(options, branch);
  const picked = policyFor(root, commit, target === undefined ? undefined : knownTarget(root, target));
  if (!picked.ok) {
    for (const error of picked.errors) io.err(`gotreceipts verify: CANNOT RUN: ${error}`);
    return EXIT.CANNOT_RUN;
  }
  const { policy } = picked;

  const chosen = chooseLevel(policy, options, branch);
  if ('error' in chosen) return cannotRun(chosen.error);

  const { decision, unreadable } = judgeCommit(root, policy, commit, chosen.level, Date.now());

  const shortCommit = commit.slice(0, 7);
  io.out(`gotreceipts verify: commit ${shortCommit} needs level ${chosen.level}`);
  const [policyLine = '', ...policyNotes] = sourceLines(picked.source);
  io.out(`  policy: ${policyLine}`);
  for (const note of policyNotes) io.out(`  ${note}`);
  for (const file of unreadable) {
    io.out(`  ignored, not a valid record: ${file}`);
  }

  if (decision.ok) {
    const { record } = decision;
    io.out(`  ${record.level} record, passed ${shownAge(decision.ageHours)} hours ago, under the current policy`);
    io.out(`VERDICT: PASS (commit ${shortCommit} satisfies level ${chosen.level})`);
    return EXIT.PASS;
  }

  for (const detail of decision.details) io.out(`  ${detail}`);
  io.out(`VERDICT: REFUSED (${decision.summary})`);
  // The advice repeats how the level was asked for, so the gate reads the same policy as this did.
  const how = options.level !== undefined ? ` --level ${options.level}` : options.for !== undefined ? ` --for ${options.for}` : '';
  io.out(`To make a record: gotreceipts gate${how}`);
  return EXIT.REFUSED;
}
