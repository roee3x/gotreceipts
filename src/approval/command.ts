import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { proofOf, rulesFor, type Proof } from '../door/judge.ts';
import { approvalLines, countedRecord, policyLines, policyWords } from '../door/report.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { differingFiles, git, repoRoot, shortId } from '../git.ts';
import type { Io } from '../main.ts';
import { pullRequestNow, pullRequestNumber, targetOf, whyNotOpen } from '../merge/target.ts';
import { commitAskedFor, readOptions } from '../options.ts';
import { knownTarget, type PolicySource, type Target } from '../policy/committed.ts';
import { isProtectedPath, type Policy } from '../policy/policy.ts';
import { countOf } from '../travel/receipts.ts';
import { pickRemote, sendReceipts } from '../travel/remote.ts';
import { readVersion } from '../version.ts';
import { checkSignature, signFile } from './ssh.ts';
import { approvalText, newApproval } from './statement.ts';
import { approvalLabel, keepApproval } from './store.ts';

/** Where the approval key is looked for when no other file is named. */
const DEFAULT_KEY = join('.ssh', 'gotreceipts_approval');
/** The same place, the way it is written in the help and in a message. */
const DEFAULT_KEY_SHOWN = `~/${DEFAULT_KEY.replace(/\\/g, '/')}`;
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
  `  --key <file>      The private key to sign with. Default: ${DEFAULT_KEY_SHOWN}`,
  '  -h, --help        Show this help',
  '',
  'An approval counts only when the public half of the key is listed in the policy that is',
  'already on the target branch (approval.signers in gotreceipts.json), for that one commit',
  'and that one branch, and for as many hours as that policy says.',
  '',
  'The approval is kept in this clone. When that policy says "travel": true, it is also sent',
  'to the remote, so that another clone and CI can check it. Else "gotreceipts send" does that.',
  '',
  'To make a key, once:   ssh-keygen -t ed25519 -f ~/.ssh/gotreceipts_approval',
  'Give it a passphrase. A key without one can be used by anything that runs on your machine.',
  '',
  'Exit codes: 0 = approved, 1 = not approved, 2 = the command could not run.',
].join('\n');

// --- 1. which commit, into which branch ---

/** What is to be approved: one commit, into one branch, and where that branch is now. */
interface Subject {
  readonly commit: string;
  readonly branch: string;
  readonly target: Target;
  /** The remote the pull request lives on, when the approval was asked for by its number. */
  readonly remote: string | undefined;
}

type SubjectChoice = ({ readonly ok: true } & Subject) | { readonly ok: false; readonly reason: string };

/** The head commit of a pull request, into its target branch. As in "merge", the branch is asked from the remote itself. */
function subjectOfPullRequest(root: string, typed: string): SubjectChoice {
  const no = (reason: string): SubjectChoice => ({ ok: false, reason });

  const number = pullRequestNumber(typed);
  if (number === undefined) return no('give the number of one pull request, for example: gotreceipts approve --pr 12');
  const asked = pullRequestNow(root, number);
  if (!asked.ok) return no(asked.reason);
  const { pullRequest } = asked;
  const notOpen = whyNotOpen(pullRequest);
  if (notOpen !== undefined) return no(notOpen);

  const found = targetOf(root, pullRequest);
  if (!found.ok) return no(found.reason);
  return { ok: true, commit: pullRequest.headRefOid, branch: pullRequest.baseRefName, target: found.target, remote: found.remote };
}

/** A commit that was named, or the one that is checked out, into a branch as this clone last saw it. */
function subjectNamed(root: string, named: string | undefined, branch: string | undefined): SubjectChoice {
  if (branch === undefined) {
    return { ok: false, reason: 'say which branch the commit is approved into: --for <branch>, or name a pull request with --pr' };
  }
  const asked = commitAskedFor(root, named);
  if (!asked.ok) return asked;
  return { ok: true, commit: asked.commit, branch, target: knownTarget(root, branch), remote: undefined };
}

// --- 2. what is shown before anything is signed ---

/** The files that would change on the target branch, the protected ones first. They are the reason a person is asked at all. */
function changeLines(root: string, policy: Policy, source: PolicySource, commit: string): string[] {
  if (source.kind !== 'target') return [];
  const files = differingFiles(root, source.commit, commit) ?? [];
  const marked = files.map((path) => ({ path, protected: isProtectedPath(policy, path) }));
  marked.sort((a, b) => Number(b.protected) - Number(a.protected));

  const rest = marked.length - FILES_SHOWN;
  return [
    `changes: ${files.length} ${files.length === 1 ? 'file is' : 'files are'} not the same as on ${source.shown}`,
    ...marked.slice(0, FILES_SHOWN).map((file) => `  ${file.protected ? '[protected] ' : ''}${file.path}`),
    ...(rest > 0 ? [`  and ${rest} more. All of them: git diff --stat ${shortId(source.commit)} ${shortId(commit)}`] : []),
  ];
}

/** Where the commit stands now: its record, and whether anything asks for an approval at all. */
function standingLines(proof: Proof, branch: string): string[] {
  const { record, approval } = proof;
  return [
    record.ok
      ? `record: ${countedRecord(record)}`
      : `record: NONE THAT COUNTS (${record.summary}). An approval does not replace the record: the gate must still pass`,
    ...(approval.kind === 'not-needed' ? [`approval: nothing asks for one. This commit may enter "${branch}" without it`] : approvalLines(approval)),
  ];
}

// --- 3. the key, and the word ---

type KeyChoice = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly reason: string };

function keyFile(named: string | undefined): KeyChoice {
  const file = named ?? join(homedir(), DEFAULT_KEY);
  if (existsSync(file)) return { ok: true, file };
  return {
    ok: false,
    reason:
      named !== undefined
        ? `there is no key file "${named}"`
        : `there is no approval key at ${DEFAULT_KEY_SHOWN}. Make one with "ssh-keygen -t ed25519 -f ~/.ssh/gotreceipts_approval", or name another with --key`,
  };
}

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

// --- 4. signing ---

type Signing =
  | { readonly kind: 'signed'; readonly signer: string }
  | { readonly kind: 'not-approved'; readonly why: string; readonly more: readonly string[] }
  | { readonly kind: 'cannot-run'; readonly reason: string };

/** What the policy says about approvals: who may sign, and for how long a signature counts. */
type ApprovalRules = NonNullable<Policy['approval']>;

/**
 * Writes the approval, signs it, checks the new signature the way every door will, and only
 * then keeps it in this clone. It is done in a folder of its own, which is removed again.
 */
function signAndKeep(root: string, subject: Subject, approval: ApprovalRules, key: string, now: number): Signing {
  const { commit, branch } = subject;
  const folder = mkdtempSync(join(tmpdir(), 'gotreceipts-approve-'));
  try {
    const statementFile = join(folder, 'approval.json');
    writeFileSync(statementFile, approvalText(newApproval(commit, branch, readVersion(), now)));

    const signed = signFile(key, statementFile);
    if (!signed.ok) return { kind: 'not-approved', why: `nothing was signed: ${signed.reason}`, more: [] };

    const check = checkSignature(approval.signers, readFileSync(statementFile), signed.signatureFile);
    if (check.kind === 'cannot-check') return { kind: 'cannot-run', reason: `the new signature could not be checked: ${check.reason}` };
    if (check.kind === 'bad') {
      return {
        kind: 'not-approved',
        why: 'the key that signed is not one the policy lists, so the signature would not count',
        more: [`Its public half must be listed under approval.signers in gotreceipts.json, on "${branch}" itself.`],
      };
    }

    if (!keepApproval(root, commit, branch, statementFile, signed.signatureFile)) {
      return { kind: 'cannot-run', reason: 'the approval was signed, and could not be written into the .git folder' };
    }
    return { kind: 'signed', signer: check.signer };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// --- 5. sending ---

/**
 * Sends the new approval to the remote, so that another clone and CI can see it, and says in
 * one line what happened. `notSent` is the reason when it did not go.
 *
 * The clock is read here, and not taken from the start of the run: between the two a person
 * read the screen and typed, and that can take minutes.
 */
function sendOn(root: string, subject: Subject): { readonly line: string; readonly notSent?: string } {
  const notSent = (reason: string) => ({ line: `NOT SENT to the remote: ${reason}`, notSent: reason });

  const remote = pickRemote(root, subject.remote);
  if (!remote.ok) return notSent(remote.reason);
  const sent = sendReceipts(root, remote.name, subject.commit, Date.now());
  if (sent.kind === 'error') return notSent(sent.reason);
  return { line: sent.kind === 'sent' ? `sent to ${remote.name}: ${countOf(sent.sent)}` : `${remote.name} already holds it` };
}

export async function approveCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'approve', usage: APPROVE_USAGE, values: ['for', 'pr', 'key'], positionals: true }, args, io);
  if (start.done) return start.code;
  const { options, positionals, cannotRun } = start;

  const say = (line: string): void => io.out(`  ${line}`);

  if (positionals.length > 1) return cannotRun('name one commit, not several');
  if (options.pr !== undefined && (options.for !== undefined || positionals.length > 0)) {
    return cannotRun('give either --pr, or a commit with --for, not both');
  }

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');

  // 1. Which commit, into which branch, and where that branch is now.
  const subject = options.pr !== undefined ? subjectOfPullRequest(root, options.pr) : subjectNamed(root, positionals[0], options.for);
  if (!subject.ok) return cannotRun(subject.reason);
  const { commit, branch } = subject;
  const shortCommit = shortId(commit);

  // 2. The rules the commit is judged by: the policy on the target branch. Its signers are the ones that count.
  const rules = rulesFor(root, commit, subject.target);
  if (!rules.ok) return cannotRun(...rules.errors);
  const { policy, source, tier } = rules;
  if (tier === undefined) return cannotRun(`the policy sets no level for "${branch}", so nothing there asks for an approval`);
  const { approval } = policy;
  if (approval === undefined) {
    return cannotRun(
      `the policy (${policyWords(source).which}) lists no signer, so there is no key an approval could be checked against. A first key is listed under approval.signers in gotreceipts.json`,
    );
  }

  // 3. What is about to be approved, shown before anything is signed.
  const now = Date.now();
  const proof = proofOf(root, rules, { commit, level: tier.level, branch, now });
  const title = git(['log', '-1', '--format=%s', commit], root).stdout.trim();
  io.out(`gotreceipts approve: commit ${shortCommit} into "${branch}"`);
  say(`commit: ${shortCommit} ${title}`);
  for (const line of [...policyLines(source), ...standingLines(proof, branch), ...changeLines(root, policy, source, commit)]) say(line);
  say(`signers the policy lists: ${approval.signers.map((signer) => signer.name).join(', ')}`);

  // 4. The key.
  const key = keyFile(options.key);
  if (!key.ok) return cannotRun(key.reason);

  // 5. The person says yes, in a whole word.
  io.out('');
  io.out(`Type "${CONFIRM_WORD}" and press Enter to sign this. Anything else stops here.`);
  if ((await readAnswer()) !== CONFIRM_WORD) {
    io.out('VERDICT: NOT APPROVED (stopped before signing. Nothing was signed)');
    return EXIT.REFUSED;
  }

  // 6. Sign, check the signature, keep it.
  const signing = signAndKeep(root, subject, approval, key.file, now);
  if (signing.kind === 'cannot-run') return cannotRun(signing.reason);
  if (signing.kind === 'not-approved') {
    io.out(`VERDICT: NOT APPROVED (${signing.why})`);
    for (const line of signing.more) io.out(line);
    return EXIT.REFUSED;
  }
  say(`signed by ${signing.signer}`);
  say(`kept as ${approvalLabel(commit, branch)}`);
  say(`it counts for ${approval.maxAgeHours} hours, for this commit and this branch only`);

  // 7. When the policy says records and approvals travel, it goes to the remote now. The
  //    approval stands either way: it is signed and kept.
  const sending = policy.travel === true ? sendOn(root, subject) : undefined;
  say(sending?.line ?? `it stays in this clone. To let another clone or CI see it: gotreceipts send ${shortCommit}`);

  io.out(`VERDICT: APPROVED (commit ${shortCommit} into "${branch}", by ${signing.signer})`);
  if (sending?.notSent !== undefined) {
    io.out(`It is signed and kept, and other clones and CI cannot see it yet. Send it: gotreceipts send ${shortCommit}`);
  }
  return EXIT.PASS;
}
