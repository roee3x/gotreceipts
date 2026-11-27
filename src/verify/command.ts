import { proofOf, rulesFor } from '../door/judge.ts';
import { approvalAdvice, approvalLines, approvalNotChecked, policyLines, recordButNoApproval, recordLines } from '../door/report.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { currentBranch, repoRoot, shortId } from '../git.ts';
import type { Io } from '../main.ts';
import { commitAskedFor, readOptions } from '../options.ts';
import { knownTarget } from '../policy/committed.ts';
import { chooseLevel, targetBranch } from '../policy/level.ts';

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

  // The question. The branch is found the way this clone last saw it: "verify" works without a network.
  const checkedOut = currentBranch(root);
  const branch = targetBranch(options, checkedOut);
  const rules = rulesFor(root, commit, branch === undefined ? undefined : knownTarget(root, branch));
  if (!rules.ok) return cannotRun(...rules.errors);

  const chosen = chooseLevel(rules.policy, options, checkedOut);
  if ('error' in chosen) return cannotRun(chosen.error);
  const { level } = chosen;

  const proof = proofOf(root, rules, { commit, level, branch, now: Date.now() });
  const { record, approval } = proof;

  // The answer, in the order of the question: the policy, the record, the approval.
  const shortCommit = shortId(commit);
  io.out(`gotreceipts verify: commit ${shortCommit} needs level ${level}`);
  for (const line of [...policyLines(rules.source), ...recordLines(proof), ...approvalLines(approval)]) io.out(`  ${line}`);

  const lacksApproval = approval.kind === 'refused' && branch !== undefined;
  const advice = lacksApproval ? approvalAdvice({ commit, branch }) : [];

  if (!record.ok) {
    io.out(`VERDICT: REFUSED (${record.summary})`);
    for (const line of advice) io.out(line);
    // The advice repeats how the level was asked for, so the gate reads the same policy as this did.
    // It is the last line: the record is what the reader can make themselves.
    const how = options.level !== undefined ? ` --level ${options.level}` : options.for !== undefined ? ` --for ${options.for}` : '';
    io.out(`To make a record: gotreceipts gate${how}`);
    return EXIT.REFUSED;
  }
  if (approval.kind === 'cannot-check') return cannotRun(approvalNotChecked(approval.reason));
  if (lacksApproval) {
    io.out(`VERDICT: REFUSED (${recordButNoApproval(commit, branch)})`);
    for (const line of advice) io.out(line);
    return EXIT.REFUSED;
  }

  const approved = approval.kind === 'approved' && branch !== undefined ? `, and is approved for "${branch}"` : '';
  io.out(`VERDICT: PASS (commit ${shortCommit} satisfies level ${level}${approved})`);
  return EXIT.PASS;
}
