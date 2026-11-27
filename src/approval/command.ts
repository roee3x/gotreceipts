import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { differingFiles, fetchRef, git, hasCommit, remoteBranchTip, repoRoot, resolveCommit } from '../git.ts';
import type { Io } from '../main.ts';
import { remoteFor } from '../merge/command.ts';
import { viewPullRequest } from '../merge/github.ts';
import { knownTarget, policyFor, sourceLines, type Target } from '../policy/committed.ts';
import { isProtectedPath, tierForBranch } from '../policy/policy.ts';
import { shownAge } from '../verify/decide.ts';
import { judgeCommit } from '../verify/judge.ts';
import { readVersion } from '../version.ts';
import { approvalLines, judgeApproval } from './judge.ts';
import { checkSignature, signFile } from './ssh.ts';
import { approvalText, newApproval } from './statement.ts';
import { approvalLabel, keepApproval } from './store.ts';

/** Where the approval key is looked for when no other file is named. */
const DEFAULT_KEY = join('.ssh', 'gotreceipts_approval');
/** The word the person types to sign. A whole word, so that it is not typed by reflex. */
const CONFIRM_WORD = 'approve';
/** How many changed files are written out before the rest is only counted. */
const FILES_SHOWN = 20;

export const APPROVE_USAGE = [
  'Usage: gotreceipts approve [commit] --for <branch> [options]',
  '       gotreceipts approve --pr <number> [options]',
  '',
  'Signs an approval: "exactly this commit may enter exactly this branch". It is the one',
  'command of this tool that is meant for a person, in their own terminal, and not for a',
  'coding agent.',
  '',
  'It shows what is about to be approved: the commit, the branch, the record of the gate,',
  `and the files that would change, with the protected ones marked. Then it waits for the`,
  `word "${CONFIRM_WORD}", and signs with your key. When the key has a passphrase, ssh-keygen asks`,
  'for it. This tool never sees what you type there.',
  '',
  'Which commit, into which branch:',
  '  [commit] --for <branch>  This commit (the one that is checked out, when none is named)',
  '                           into this branch',
  '  --pr <number>            The head commit of this pull request into its target branch.',
  '                           GitHub is asked, through the "gh" tool',
  '',
  'Options:',
  `  --key <file>      The private key to sign with. Default: ~/${DEFAULT_KEY.replace(/\\/g, '/')}`,
  '  -h, --help        Show this help',
  '',
  'An approval counts only when the public half of the key is listed in the policy that is',
  'already on the target branch (approval.signers in gotreceipts.json), for that one commit',
  'and that one branch, and for as many hours as that policy says.',
  '',
  'To make a key, once:   ssh-keygen -t ed25519 -f ~/.ssh/gotreceipts_approval',
  'Give it a passphrase. A key without one can be used by anything that runs on your machine.',
  '',
  'Exit codes: 0 = approved, 1 = not approved, 2 = the command could not run.',
].join('\n');

/** The first line that arrives on the input, or an empty text when the input ends without one. */
function readAnswer(): Promise<string> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin });
    let answered = false;
    lines.once('line', (line) => {
      answered = true;
      lines.close();
      resolve(line.trim());
    });
    lines.once('close', () => {
      if (!answered) resolve('');
    });
  });
}

export async function approveCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  let options: { for?: string; pr?: string; key?: string; help?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        for: { type: 'string' },
        pr: { type: 'string' },
        key: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
    options = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    io.err(`gotreceipts approve: ${error instanceof Error ? error.message : String(error)}`);
    io.err(APPROVE_USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (options.help === true) {
    io.out(APPROVE_USAGE);
    return EXIT.PASS;
  }

  const cannotRun = (reason: string): ExitCode => {
    io.err(`gotreceipts approve: CANNOT RUN: ${reason}`);
    return EXIT.CANNOT_RUN;
  };
  const notApproved = (why: string, more: readonly string[] = []): ExitCode => {
    io.out(`VERDICT: NOT APPROVED (${why})`);
    for (const line of more) io.out(line);
    return EXIT.REFUSED;
  };

  if (positionals.length > 1) return cannotRun('name one commit, not several');
  if (options.pr !== undefined && (options.for !== undefined || positionals.length > 0)) {
    return cannotRun('give either --pr, or a commit with --for, not both');
  }

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  // 1. Which commit, into which branch, and where that branch is now.
  let commit: string;
  let branch: string;
  let target: Target;

  if (options.pr !== undefined) {
    const wanted = options.pr.replace(/^#/, '');
    if (!/^[1-9]\d*$/.test(wanted)) return cannotRun('give the number of one pull request, for example: gotreceipts approve --pr 12');
    const number = Number(wanted);
    const viewed = viewPullRequest(root, number);
    if (!viewed.ok) return cannotRun(`GitHub could not be asked about pull request #${number}: ${viewed.error}`);
    const pullRequest = viewed.value;
    if (pullRequest.state !== 'OPEN') {
      return cannotRun(`pull request #${number} is not open: GitHub shows it as ${pullRequest.state.toLowerCase()}`);
    }
    commit = pullRequest.headRefOid;
    branch = pullRequest.baseRefName;

    // As in the merge command: the target branch is asked from the remote itself.
    const remote = remoteFor(root, pullRequest.url);
    if (remote === undefined) return cannotRun('this repository has no remote, so the target branch cannot be read');
    const tip = remoteBranchTip(root, remote, branch);
    if (tip === undefined) return cannotRun(`the remote "${remote}" could not say where "${branch}" is now`);
    if (!hasCommit(root, tip) && !(fetchRef(root, remote, `refs/heads/${branch}`) && hasCommit(root, tip))) {
      return cannotRun(`the newest commit of "${branch}" could not be downloaded`);
    }
    if (!hasCommit(root, commit) && !(fetchRef(root, remote, `refs/pull/${number}/head`) && hasCommit(root, commit))) {
      return cannotRun(`commit ${commit.slice(0, 7)} of the pull request could not be downloaded`);
    }
    target = { branch, commit: tip, shown: `${remote}/${branch}` };
  } else {
    if (options.for === undefined) return cannotRun('say which branch the commit is approved into: --for <branch>, or name a pull request with --pr');
    const wanted = positionals[0] ?? 'HEAD';
    const resolved = resolveCommit(root, wanted);
    if (resolved === undefined) {
      return cannotRun(positionals[0] === undefined ? 'the repository has no commit yet' : `there is no commit "${wanted}"`);
    }
    commit = resolved;
    branch = options.for;
    target = knownTarget(root, branch);
  }
  const shortCommit = commit.slice(0, 7);

  // 2. The policy the commit is judged by: the one on the target branch. Its signers are the ones that count.
  const picked = policyFor(root, commit, target);
  if (!picked.ok) {
    for (const error of picked.errors) io.err(`gotreceipts approve: CANNOT RUN: ${error}`);
    return EXIT.CANNOT_RUN;
  }
  const { policy, source } = picked;
  const [policyLine = '', ...policyNotes] = sourceLines(source);

  const tier = tierForBranch(policy, branch);
  if (tier === undefined) return cannotRun(`the policy sets no level for "${branch}", so nothing there asks for an approval`);
  if (policy.approval === undefined) {
    return cannotRun(
      `the policy (${policyLine}) lists no signer, so there is no key an approval could be checked against. A first key is listed under approval.signers in gotreceipts.json`,
    );
  }

  // 3. What is about to be approved, shown before anything is signed.
  const now = Date.now();
  const subject = git(['log', '-1', '--format=%s', commit], root).stdout.trim();
  io.out(`gotreceipts approve: commit ${shortCommit} into "${branch}"`);
  io.out(`  commit: ${shortCommit} ${subject}`);
  io.out(`  policy: ${policyLine}`);
  for (const note of policyNotes) io.out(`  ${note}`);

  const { decision } = judgeCommit(root, policy, commit, tier.level, now);
  io.out(
    decision.ok
      ? `  record: ${decision.record.level} record, passed ${shownAge(decision.ageHours)} hours ago, under the current policy`
      : `  record: NONE THAT COUNTS (${decision.summary}). An approval does not replace the record: the gate must still pass`,
  );

  const standing = judgeApproval(root, policy, source, commit, branch, now);
  if (standing.kind === 'not-needed') {
    io.out(`  approval: nothing asks for one. This commit may enter "${branch}" without it`);
  } else {
    for (const line of approvalLines(standing)) io.out(`  ${line}`);
  }

  if (source.kind === 'target') {
    const files = differingFiles(root, source.commit, commit) ?? [];
    const marked = files.map((path) => ({ path, protected: isProtectedPath(policy, path) }));
    // The protected ones first. They are the reason a person is asked at all.
    marked.sort((a, b) => Number(b.protected) - Number(a.protected));
    io.out(`  changes: ${files.length} ${files.length === 1 ? 'file is' : 'files are'} not the same as on ${source.shown}`);
    for (const file of marked.slice(0, FILES_SHOWN)) io.out(`    ${file.protected ? '[protected] ' : ''}${file.path}`);
    if (marked.length > FILES_SHOWN) io.out(`    and ${marked.length - FILES_SHOWN} more. All of them: git diff --stat ${source.commit.slice(0, 7)} ${shortCommit}`);
  }
  io.out(`  signers the policy lists: ${policy.approval.signers.map((signer) => signer.name).join(', ')}`);

  // 4. The key.
  const keyFile = options.key ?? join(homedir(), DEFAULT_KEY);
  if (!existsSync(keyFile)) {
    return cannotRun(
      options.key !== undefined
        ? `there is no key file "${options.key}"`
        : `there is no approval key at ~/${DEFAULT_KEY.replace(/\\/g, '/')}. Make one with "ssh-keygen -t ed25519 -f ~/.ssh/gotreceipts_approval", or name another with --key`,
    );
  }

  // 5. The person says yes, in a whole word.
  io.out('');
  io.out(`Type "${CONFIRM_WORD}" and press Enter to sign this. Anything else stops here.`);
  if ((await readAnswer()) !== CONFIRM_WORD) return notApproved('stopped before signing. Nothing was signed');

  // 6. Sign, in a folder of its own, then check the signature the way every door will.
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-approve-'));
  try {
    const statementFile = join(folder, 'approval.json');
    writeFileSync(statementFile, approvalText(newApproval(commit, branch, readVersion(), now)));

    const signed = signFile(keyFile, statementFile);
    if (!signed.ok) return notApproved(`nothing was signed: ${signed.reason}`);

    const check = checkSignature(policy.approval.signers, readFileSync(statementFile), signed.signatureFile);
    if (check.kind === 'cannot-check') return cannotRun(`the new signature could not be checked: ${check.reason}`);
    if (check.kind === 'bad') {
      return notApproved('the key that signed is not one the policy lists, so the signature would not count', [
        `Its public half must be listed under approval.signers in gotreceipts.json, on "${branch}" itself.`,
      ]);
    }

    if (!keepApproval(root, commit, branch, statementFile, signed.signatureFile)) {
      return cannotRun('the approval was signed, and could not be written into the .git folder');
    }
    io.out(`  signed by ${check.signer}`);
    io.out(`  kept as ${approvalLabel(commit, branch)}`);
    io.out(`  it counts for ${policy.approval.maxAgeHours} hours, for this commit and this branch only`);
    io.out(`VERDICT: APPROVED (commit ${shortCommit} into "${branch}", by ${check.signer})`);
    return EXIT.PASS;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
