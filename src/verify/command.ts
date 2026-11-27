import { approvalAdvice, approvalLines, judgeApproval, type ApprovalDecision } from '../approval/judge.ts';
import { shownAge } from '../clock.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { chooseLevel, targetBranch } from '../gate/command.ts';
import { currentBranch, repoRoot, shortId } from '../git.ts';
import type { Io } from '../main.ts';
import { commitAskedFor, readOptions } from '../options.ts';
import { knownTarget, policyFor, sourceLines } from '../policy/committed.ts';
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
  'When the branch asks for an approval, or the commit would change a protected file, the commit',
  'also needs a valid signed approval for that branch. An owner gives it with "gotreceipts approve".',
  '',
  'Exit codes: 0 = the commit has what it needs, 1 = it does not, 2 = the question could not be answered.',
].join('\n');

export async function verifyCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'verify', usage: VERIFY_USAGE, values: ['level', 'for'], positionals: true }, args, io);
  if (start.done) return start.code;
  const { options, positionals, cannotRun } = start;

  if (positionals.length > 1) return cannotRun('name one commit, not several');

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  const asked = commitAskedFor(root, positionals[0]);
  if (!asked.ok) return cannotRun(asked.reason);
  const { commit } = asked;

  // The policy: the one on the branch the commit wants to enter, not the commit's own copy.
  const branch = currentBranch(root);
  const target = targetBranch(options, branch);
  const picked = policyFor(root, commit, target === undefined ? undefined : knownTarget(root, target));
  if (!picked.ok) return cannotRun(...picked.errors);
  const { policy } = picked;

  const chosen = chooseLevel(policy, options, branch);
  if ('error' in chosen) return cannotRun(chosen.error);

  const { decision, unreadable } = judgeCommit(root, policy, commit, chosen.level, Date.now());

  const shortCommit = shortId(commit);
  io.out(`gotreceipts verify: commit ${shortCommit} needs level ${chosen.level}`);
  const [policyLine = '', ...policyNotes] = sourceLines(picked.source);
  io.out(`  policy: ${policyLine}`);
  for (const note of policyNotes) io.out(`  ${note}`);
  for (const file of unreadable) {
    io.out(`  ignored, not a valid record: ${file}`);
  }

  if (decision.ok) {
    io.out(`  ${decision.record.level} record, passed ${shownAge(decision.ageHours)} hours ago, under the current policy`);
  } else {
    for (const detail of decision.details) io.out(`  ${detail}`);
  }

  // The approval. It is a question about entering a branch, so it is only asked when one is named.
  const approval: ApprovalDecision =
    target === undefined ? { kind: 'not-needed' } : judgeApproval(root, policy, picked.source, commit, target, Date.now());
  for (const line of approvalLines(approval)) io.out(`  ${line}`);

  if (!decision.ok) {
    io.out(`VERDICT: REFUSED (${decision.summary})`);
    if (approval.kind === 'refused' && target !== undefined) for (const line of approvalAdvice(commit, target)) io.out(line);
    // The advice repeats how the level was asked for, so the gate reads the same policy as this did.
    // It is the last line: the record is what the reader can make themselves.
    const how = options.level !== undefined ? ` --level ${options.level}` : options.for !== undefined ? ` --for ${options.for}` : '';
    io.out(`To make a record: gotreceipts gate${how}`);
    return EXIT.REFUSED;
  }
  if (approval.kind === 'cannot-check') return cannotRun(`the approval could not be checked: ${approval.reason}`);
  if (approval.kind === 'refused' && target !== undefined) {
    io.out(`VERDICT: REFUSED (commit ${shortCommit} has its record, and no valid approval for "${target}")`);
    for (const line of approvalAdvice(commit, target)) io.out(line);
    return EXIT.REFUSED;
  }

  const approved = approval.kind === 'approved' && target !== undefined ? `, and is approved for "${target}"` : '';
  io.out(`VERDICT: PASS (commit ${shortCommit} satisfies level ${chosen.level}${approved})`);
  return EXIT.PASS;
}
