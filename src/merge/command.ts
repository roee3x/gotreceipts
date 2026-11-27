import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { fetchRef, hasCommit, headCommit, mergedTree, remoteBranchTip, remotes, treeOf } from '../git.ts';
import type { Io } from '../main.ts';
import { loadPolicy } from '../policy/load.ts';
import { tierForBranch } from '../policy/policy.ts';
import { shownAge } from '../verify/decide.ts';
import { judgeCommit } from '../verify/judge.ts';
import {
  MERGE_METHODS,
  mergeCommitOf,
  mergePullRequest,
  repositoryOf,
  viewPullRequest,
  type MergeMethod,
} from './github.ts';

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
  'Then it asks GitHub to merge that exact commit and no other.',
  'After the merge it compares what GitHub made with what was tested.',
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

/** The remote that holds the pull request's repository: the one whose address names it, else "origin". */
function remoteFor(root: string, pullRequestUrl: string): string | undefined {
  const all = remotes(root);
  const repository = repositoryOf(pullRequestUrl)?.toLowerCase();
  if (repository !== undefined) {
    const named = all.find((remote) => {
      const address = remote.url.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
      return address.endsWith(`/${repository}`) || address.endsWith(`:${repository}`);
    });
    if (named !== undefined) return named.name;
  }
  return (all.find((remote) => remote.name === 'origin') ?? all[0])?.name;
}

export async function mergeCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  let options: { method?: string; subject?: string; body?: string; help?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        method: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
    options = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(`gotreceipts merge: ${error instanceof Error ? error.message : String(error)}`);
    io.err(MERGE_USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (options.help === true) {
    io.out(MERGE_USAGE);
    return EXIT.PASS;
  }

  const cannotRun = (reason: string): ExitCode => {
    io.err(`gotreceipts merge: CANNOT RUN: ${reason}`);
    return EXIT.CANNOT_RUN;
  };
  const refused = (summary: string, advice: readonly string[] = []): ExitCode => {
    io.out(`VERDICT: REFUSED (${summary}). Nothing was merged.`);
    for (const line of advice) io.out(line);
    return EXIT.REFUSED;
  };

  const wanted = positionals[0]?.replace(/^#/, '');
  if (positionals.length !== 1 || wanted === undefined || !/^[1-9]\d*$/.test(wanted)) {
    return cannotRun('give the number of one pull request, for example: gotreceipts merge 12');
  }
  const number = Number(wanted);

  const method = options.method ?? 'merge';
  if (!(MERGE_METHODS as readonly string[]).includes(method)) {
    return cannotRun(`there is no merge method "${method}" (methods: ${MERGE_METHODS.join(', ')})`);
  }

  const loaded = loadPolicy(process.cwd());
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`gotreceipts merge: CANNOT RUN: ${error}`);
    return EXIT.CANNOT_RUN;
  }
  const { policy, root } = loaded;
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  // 1. The pull request, as GitHub has it now.
  const viewed = viewPullRequest(root, number);
  if (!viewed.ok) return cannotRun(`GitHub could not be asked about pull request #${number}: ${viewed.error}`);
  const pullRequest = viewed.value;
  const { baseRefName: base, headRefOid: commit } = pullRequest;
  const shortCommit = commit.slice(0, 7);

  io.out(`gotreceipts merge: pull request #${number}, ${pullRequest.headRefName} into ${base}`);
  if (pullRequest.state !== 'OPEN') {
    return refused(`pull request #${number} is not open: GitHub shows it as ${pullRequest.state.toLowerCase()}`);
  }
  if (pullRequest.isDraft) return refused(`pull request #${number} is a draft`);

  // 2. The record. 3. The merged result.
  const tier = tierForBranch(policy, base);
  let testedTree: string | undefined;
  let remote: string | undefined;

  if (tier === undefined) {
    io.out(`  the policy sets no level for "${base}", so no record is needed`);
  } else {
    io.out(`  commit ${shortCommit} needs level ${tier.level}`);
    const { decision, unreadable } = judgeCommit(root, policy, commit, tier.level, Date.now());
    for (const file of unreadable) io.out(`  ignored, not a valid record: ${file}`);
    if (!decision.ok) {
      for (const detail of decision.details) io.out(`  ${detail}`);
      const command = `gotreceipts gate --for ${base}`;
      return refused(decision.summary, [
        `To make a record: ${command}${commit === headCommit(root) ? '' : `   (with commit ${shortCommit} checked out)`}`,
      ]);
    }
    io.out(`  ${decision.record.level} record, passed ${shownAge(decision.ageHours)} hours ago, under the current policy`);

    remote = remoteFor(root, pullRequest.url);
    if (remote === undefined) return cannotRun('this repository has no remote, so the target branch cannot be read');
    const baseTip = remoteBranchTip(root, remote, base);
    if (baseTip === undefined) return cannotRun(`the remote "${remote}" could not say where "${base}" is now`);
    if (!hasCommit(root, baseTip) && !(fetchRef(root, remote, `refs/heads/${base}`) && hasCommit(root, baseTip))) {
      return cannotRun(`the newest commit of "${base}" could not be downloaded`);
    }
    if (!hasCommit(root, commit) && !(fetchRef(root, remote, `refs/pull/${number}/head`) && hasCommit(root, commit))) {
      return cannotRun(`commit ${shortCommit} of the pull request could not be downloaded`);
    }

    const merged = mergedTree(root, baseTip, commit);
    if (merged.kind === 'error') return cannotRun(`git could not work out the merged result: ${merged.message}`);
    if (merged.kind === 'conflict') {
      return refused(`commit ${shortCommit} conflicts with "${base}"`, [
        `Merge ${base} into the branch, settle the conflicts, run the gate on the new commit, and merge again.`,
      ]);
    }
    testedTree = treeOf(root, commit);
    if (testedTree === undefined) return cannotRun(`git could not read the files of commit ${shortCommit}`);
    if (merged.tree !== testedTree) {
      return refused('the merged result would not be what was tested', [
        `"${base}" holds changes that commit ${shortCommit} does not contain, so the merge would produce files no gate has seen.`,
        `Merge ${base} into the branch, run the gate on the new commit, and merge again.`,
      ]);
    }
    io.out(`  the merged result holds exactly the files of commit ${shortCommit}`);
  }

  // 4. The merge, pinned to the commit that was checked.
  io.out(`  asking GitHub to merge commit ${shortCommit}, and no other`);
  const request = mergePullRequest(root, {
    number,
    commit,
    method: method as MergeMethod,
    subject: options.subject,
    body: options.body,
  });
  if (!request.ok) return refused('GitHub did not merge the pull request', [`GitHub said: ${request.error}`]);
  for (const line of request.value.split('\n')) {
    if (line.trim() !== '') io.out(`  gh: ${line.trim()}`);
  }

  if (testedTree === undefined || remote === undefined) {
    io.out(`VERDICT: MERGED (pull request #${number}, commit ${shortCommit} into ${base}, a branch with no level)`);
    return EXIT.PASS;
  }

  // 5. What GitHub made, compared with what was tested. The target branch can move in the
  //    moment between the check and the merge. That cannot be prevented from here, so it is detected.
  const after = mergeCommitOf(root, number);
  const mergeCommit = after.ok && after.value.state === 'MERGED' ? after.value.commit : undefined;
  if (mergeCommit === undefined) {
    io.out('VERDICT: NOT CONFIRMED (GitHub accepted the request, and does not show the pull request as merged yet)');
    io.out(`Look at it: gh pr view ${number}`);
    return EXIT.CANNOT_RUN;
  }
  if (!hasCommit(root, mergeCommit)) fetchRef(root, remote, `refs/heads/${base}`);
  const resultTree = treeOf(root, mergeCommit);
  const shortMerge = mergeCommit.slice(0, 7);
  if (resultTree === undefined) {
    io.out(`VERDICT: MERGED, NOT COMPARED (commit ${shortMerge} on ${base} could not be downloaded to compare it with what was tested)`);
    return EXIT.CANNOT_RUN;
  }
  if (resultTree !== testedTree) {
    io.out(`VERDICT: MERGED, BUT NOT AS TESTED (commit ${shortMerge} on ${base} holds files that no gate has seen)`);
    io.out(`"${base}" moved in the moment between the check and the merge.`);
    io.out(`Run the gate on it now: gotreceipts gate --for ${base}   (with commit ${shortMerge} checked out)`);
    return EXIT.REFUSED;
  }

  io.out(`  merged as ${shortMerge}, which holds exactly the tested files`);
  io.out(`VERDICT: MERGED (pull request #${number}, commit ${shortCommit} into ${base})`);
  return EXIT.PASS;
}
