import { proofOf, rulesFor, type Rules } from '../door/judge.ts';
import { approvalAdvice, approvalLines, approvalNotChecked, gateAdvice, policyLines, recordButNoApproval, recordLines } from '../door/report.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { branchRef, headCommit, mergedTree, obtainCommit, repoRoot, shortId, treeOf } from '../git.ts';
import type { Io } from '../main.ts';
import { readOptions } from '../options.ts';
import { countOf } from '../travel/receipts.ts';
import { fetchReceipts, sendReceipts } from '../travel/remote.ts';
import { MERGE_METHODS, mergeCommitOf, mergePullRequest, type MergeMethod, type PullRequest } from './github.ts';
import { pullRequestNow, pullRequestNumber, targetOf, whyNotOpen } from './target.ts';

export const MERGE_USAGE = [
  'Usage: gotreceipts merge <pull request number> [options]',
  '',
  'Merges a pull request on GitHub, and only when the commit it would merge has its record.',
  '',
  'Before the merge it checks, in this order:',
  '  1. The pull request is open and is not a draft.',
  '  2. Its head commit has a valid record at the level the target branch needs.',
  '  3. The merged result would hold exactly the files of that commit. When the target branch',
  '     holds changes the commit does not contain, it would not, and the merge is refused.',
  '  4. When the target branch asks for an approval, or the commit would change a protected',
  '     file: the commit has a valid signed approval for that branch ("gotreceipts approve").',
  'Then it asks GitHub to merge that exact commit and no other.',
  'After the merge it compares what GitHub made with what was tested.',
  '',
  'The level and the policy are the ones that are already on the target branch, read from the',
  'remote. What the pull request did to its own copy of gotreceipts.json does not count.',
  '',
  'When that policy says "travel": true, the remote is first asked for records and approvals',
  'of the commit, and the ones that opened the door are sent to the remote before the merge.',
  '',
  'Options:',
  '  --method <how>    merge (the default), squash or rebase',
  '  --subject <text>  The first line of the merge commit message',
  '  --body <text>     The rest of the merge commit message',
  '  -h, --help        Show this help',
  '',
  'It uses the GitHub command line tool, "gh", and the sign-in that tool already has.',
  '',
  'Exit codes: 0 = merged as tested, 1 = refused, or merged but not as tested, 2 = the command could not run.',
].join('\n');

function isMergeMethod(text: string): text is MergeMethod {
  return (MERGE_METHODS as readonly string[]).includes(text);
}

/** Prints one line of the report, moved in under its headline. */
type Say = (line: string) => void;

/** A commit that a pull request would merge into its target branch. */
interface Entering {
  readonly commit: string;
  /** The target branch, and the commit the remote has it at now. */
  readonly base: string;
  readonly baseTip: string;
  /** The level the policy asks of the target branch. */
  readonly level: string;
}

type Before =
  /** Everything holds. `testedTree` is the files of the commit, which the merged result must hold too. */
  | { readonly kind: 'go'; readonly testedTree: string }
  | { readonly kind: 'refused'; readonly summary: string; readonly advice: readonly string[] }
  | { readonly kind: 'cannot-run'; readonly reason: string };

/**
 * What is checked before a merge into a branch with a level, in this order: the record, the
 * merged result, the approval. The first one that does not hold ends it.
 *
 * The record and the approval are the answer of the one question. The merged result is the
 * merge command's own check, and it stands between the two: a record is a statement about the
 * files of one commit, so it only covers a merge that produces exactly those files.
 */
function checkBefore(root: string, rules: Rules, entering: Entering, now: number, say: Say): Before {
  const { commit, base, baseTip, level } = entering;
  const shortCommit = shortId(commit);
  const refused = (summary: string, ...advice: readonly string[]): Before => ({ kind: 'refused', summary, advice });
  const cannotRun = (reason: string): Before => ({ kind: 'cannot-run', reason });

  say(`commit ${shortCommit} needs level ${level}`);
  const proof = proofOf(root, rules, { commit, level, branch: base, now });

  for (const line of recordLines(proof)) say(line);
  if (!proof.record.ok) return refused(proof.record.summary, `To make a record: ${gateAdvice(base, commit, headCommit(root))}`);

  const merged = mergedTree(root, baseTip, commit);
  if (merged.kind === 'error') return cannotRun(`git could not work out the merged result: ${merged.message}`);
  if (merged.kind === 'conflict') {
    return refused(
      `commit ${shortCommit} conflicts with "${base}"`,
      `Merge ${base} into the branch, settle the conflicts, run the gate on the new commit, and merge again.`,
    );
  }
  const testedTree = treeOf(root, commit);
  if (testedTree === undefined) return cannotRun(`git could not read the files of commit ${shortCommit}`);
  if (merged.tree !== testedTree) {
    return refused(
      'the merged result would not be what was tested',
      `"${base}" holds changes that commit ${shortCommit} does not contain, so the merge would produce files no gate has seen.`,
      `Merge ${base} into the branch, run the gate on the new commit, and merge again.`,
    );
  }
  say(`the merged result holds exactly the files of commit ${shortCommit}`);

  const { approval } = proof;
  for (const line of approvalLines(approval)) say(line);
  if (approval.kind === 'cannot-check') return cannotRun(approvalNotChecked(approval.reason));
  if (approval.kind === 'refused') return refused(recordButNoApproval(commit, base), ...approvalAdvice({ commit, branch: base }));

  return { kind: 'go', testedTree };
}

/**
 * Asks the remote for records and approvals of the commit. The record may have been made in
 * another clone, and the approval signed on another machine. What arrives is judged like
 * anything this clone made itself.
 */
function fetchFirst(root: string, remote: string, commit: string, now: number, say: Say): void {
  const got = fetchReceipts(root, remote, commit, now);
  if (got.kind === 'error') say(`${remote} could not be asked for records and approvals of this commit: ${got.reason}`);
  if (got.kind === 'got' && got.gained.length > 0) say(`fetched from ${remote}: ${countOf(got.gained)}`);
}

/**
 * Sends the record and the approval that opened this door to the remote, before the merge, so
 * that the check on the remote's side finds them. Sending is not a check. When it fails, the
 * merge still goes on and the line says how to send them: this door was opened by what this
 * clone holds, and the far side will notice what is missing.
 */
function sendFirst(root: string, remote: string, commit: string, now: number, say: Say): void {
  const sent = sendReceipts(root, remote, commit, now);
  if (sent.kind === 'error') {
    say(`NOT SENT to ${remote}: ${sent.reason}`);
    say(`an audit on the remote will not find them. Send them: gotreceipts send ${shortId(commit)}`);
  }
  if (sent.kind === 'sent') say(`sent to ${remote}: ${countOf(sent.sent)}`);
  if (sent.kind === 'already') say(`${remote} already holds the records and approvals of this commit`);
}

/**
 * Compares what GitHub made with what was tested, and gives the verdict.
 *
 * The target branch can move in the moment between the check and the merge. That cannot be
 * prevented from here, so it is detected.
 */
function compareAfter(root: string, remote: string, pullRequest: PullRequest, testedTree: string, io: Io): ExitCode {
  const { number, baseRefName: base, headRefOid: commit } = pullRequest;

  const after = mergeCommitOf(root, number);
  const mergeCommit = after.ok && after.value.state === 'MERGED' ? after.value.commit : undefined;
  if (mergeCommit === undefined) {
    io.out('VERDICT: NOT CONFIRMED (GitHub accepted the request, and does not show the pull request as merged yet)');
    io.out(`Look at it: gh pr view ${number}`);
    return EXIT.CANNOT_RUN;
  }

  obtainCommit(root, remote, branchRef(base), mergeCommit);
  const resultTree = treeOf(root, mergeCommit);
  const shortMerge = shortId(mergeCommit);
  if (resultTree === undefined) {
    io.out(`VERDICT: MERGED, NOT COMPARED (commit ${shortMerge} on ${base} could not be downloaded to compare it with what was tested)`);
    return EXIT.CANNOT_RUN;
  }
  if (resultTree !== testedTree) {
    io.out(`VERDICT: MERGED, BUT NOT AS TESTED (commit ${shortMerge} on ${base} holds files that no gate has seen)`);
    io.out(`"${base}" moved in the moment between the check and the merge.`);
    // The merge commit was made on GitHub a moment ago, so it is never the one that is checked out here.
    io.out(`Run the gate on it now: ${gateAdvice(base, mergeCommit, undefined)}`);
    return EXIT.REFUSED;
  }

  io.out(`  merged as ${shortMerge}, which holds exactly the tested files`);
  io.out(`VERDICT: MERGED (pull request #${number}, commit ${shortId(commit)} into ${base})`);
  return EXIT.PASS;
}

export async function mergeCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'merge', usage: MERGE_USAGE, values: ['method', 'subject', 'body'], positionals: true }, args, io);
  if (start.done) return start.code;
  const { options, positionals, cannotRun } = start;

  const say: Say = (line) => io.out(`  ${line}`);
  const refused = (summary: string, advice: readonly string[] = []): ExitCode => {
    io.out(`VERDICT: REFUSED (${summary}). Nothing was merged.`);
    for (const line of advice) io.out(line);
    return EXIT.REFUSED;
  };

  const number = positionals.length === 1 ? pullRequestNumber(positionals[0]) : undefined;
  if (number === undefined) return cannotRun('give the number of one pull request, for example: gotreceipts merge 12');

  const method = options.method ?? 'merge';
  if (!isMergeMethod(method)) return cannotRun(`there is no merge method "${method}" (methods: ${MERGE_METHODS.join(', ')})`);

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  // 1. The pull request, as GitHub has it now.
  const asked = pullRequestNow(root, number);
  if (!asked.ok) return cannotRun(asked.reason);
  const { pullRequest } = asked;
  const { baseRefName: base, headRefOid: commit } = pullRequest;
  const shortCommit = shortId(commit);

  io.out(`gotreceipts merge: pull request #${number}, ${pullRequest.headRefName} into ${base}`);
  const notOpen = whyNotOpen(pullRequest);
  if (notOpen !== undefined) return refused(notOpen);
  if (pullRequest.isDraft) return refused(`pull request #${number} is a draft`);

  // 2. The target branch and the commit, both as the remote has them now.
  const found = targetOf(root, pullRequest);
  if (!found.ok) return cannotRun(found.reason);
  const { remote, target } = found;

  // 3. The rules: the policy that is already on the target branch, not the pull request's own
  //    copy, and the level that policy asks of the branch.
  const rules = rulesFor(root, commit, target);
  if (!rules.ok) return cannotRun(...rules.errors);
  for (const line of policyLines(rules.source)) say(line);
  const { tier } = rules;
  const travels = rules.policy.travel === true;
  const now = Date.now();

  if (travels) fetchFirst(root, remote, commit, now, say);

  // 4. The record, the merged result and the approval. A branch with no level asks for none of them.
  let testedTree: string | undefined;
  if (tier === undefined) {
    say(`the policy sets no level for "${base}", so no record is needed`);
  } else {
    const before = checkBefore(root, rules, { commit, base, baseTip: target.commit, level: tier.level }, now, say);
    if (before.kind === 'cannot-run') return cannotRun(before.reason);
    if (before.kind === 'refused') return refused(before.summary, before.advice);
    testedTree = before.testedTree;

    if (travels) sendFirst(root, remote, commit, now, say);
  }

  // 5. The merge, pinned to the commit that was checked.
  say(`asking GitHub to merge commit ${shortCommit}, and no other`);
  const request = mergePullRequest(root, { number, commit, method, subject: options.subject, body: options.body });
  if (!request.ok) return refused('GitHub did not merge the pull request', [`GitHub said: ${request.error}`]);
  for (const line of request.value.split('\n')) {
    if (line.trim() !== '') say(`gh: ${line.trim()}`);
  }

  // 6. What GitHub made, compared with what was tested.
  if (testedTree === undefined) {
    io.out(`VERDICT: MERGED (pull request #${number}, commit ${shortCommit} into ${base}, a branch with no level)`);
    return EXIT.PASS;
  }
  return compareAfter(root, remote, pullRequest, testedTree, io);
}
