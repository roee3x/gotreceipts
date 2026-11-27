import { proofOf, withTier, type Proof } from '../door/judge.ts';
import { approvalAdvice, approvalLines, approvalNotChecked, gateAdvice, ignoredLine, passedRecord, policyLines, policyWords } from '../door/report.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { BRANCH_PREFIX, hasCommit, headCommit, isFullId, isNoCommit, repoRoot, shortId } from '../git.ts';
import type { Io } from '../main.ts';
import { policyFor, type PolicyChoice, type PolicySource } from '../policy/committed.ts';
import type { Policy } from '../policy/policy.ts';
import { countOf } from '../travel/receipt.ts';
import { sendReceipts, type Sent } from '../travel/remote.ts';

/**
 * The pre-push hook. Git calls it before a push and gives it, as text, what the push would change.
 * Every commit that would enter a branch with a level must have a valid record at that level,
 * and a valid approval when one is needed. If one does not, the whole push is refused.
 *
 * It works in four steps, each a function of its own:
 *
 *   1. plan    Which of the pushed things is a commit entering a guarded branch, and by which rules.
 *   2. judge   What each of those commits has to show. Nothing is printed before all are judged.
 *   3. report  One block of lines per pushed thing.
 *   4. send    When everything passed and the policy says so, what opened the door goes to the remote.
 */

/** One thing a push wants to change on the other side, as git describes it to the hook. */
export interface PushedRef {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

/**
 * Reads the lines git gives a pre-push hook: "<local ref> <local id> <remote ref> <remote id>".
 * A line of any other shape is an error. A hook that guesses is a hook that lets things through.
 */
export function parsePushLines(
  text: string,
): { readonly ok: true; readonly refs: readonly PushedRef[] } | { readonly ok: false; readonly error: string } {
  const refs: PushedRef[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [localRef, localSha, remoteRef, remoteSha, ...extra] = trimmed.split(/\s+/);
    if (
      localRef === undefined ||
      localSha === undefined ||
      remoteRef === undefined ||
      remoteSha === undefined ||
      extra.length > 0 ||
      !isFullId(localSha) ||
      !isFullId(remoteSha)
    ) {
      return { ok: false, error: `git gave a line this hook does not understand: "${trimmed}"` };
    }
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return { ok: true, refs };
}

// --- 1. plan ---

/** A commit that would enter a branch, as far as the policy needs to know it. */
export interface Entering {
  readonly branch: string;
  /** The pushed commit. */
  readonly commit: string;
  /** The commit the branch points to on the remote now. Undefined when the branch is new there. */
  readonly targetCommit: string | undefined;
}

/** What the hook will do about one pushed ref. */
export type PushStep =
  | {
      readonly kind: 'check';
      readonly branch: string;
      readonly commit: string;
      readonly level: string;
      readonly policy: Policy;
      /** Where that policy came from, and what the commit would change that is protected. */
      readonly source: PolicySource;
      /** Things to say about which policy was used. Empty in the plain case. */
      readonly notes: readonly string[];
    }
  | { readonly kind: 'skip'; readonly name: string; readonly reason: string }
  /** The policy for this branch could not be read, so nothing about it can be checked. */
  | { readonly kind: 'error'; readonly name: string; readonly errors: readonly string[] };

/**
 * Decides, for every pushed ref, whether it needs a record, at which level, and under which policy.
 *
 * `policyOf` gives the policy a commit is judged by when it enters a branch: the one that is
 * already on that branch. Only a branch that policy names a level for is checked. The policy
 * says which branches are guarded, and the hook does not invent rules of its own.
 */
export function planPush(refs: readonly PushedRef[], policyOf: (entering: Entering) => PolicyChoice): PushStep[] {
  return refs.map((ref): PushStep => {
    if (!ref.remoteRef.startsWith(BRANCH_PREFIX)) {
      return { kind: 'skip', name: ref.remoteRef, reason: 'not a branch' };
    }
    const branch = ref.remoteRef.slice(BRANCH_PREFIX.length);
    if (isNoCommit(ref.localSha)) {
      return { kind: 'skip', name: branch, reason: 'the branch is being deleted, so no commit enters it' };
    }

    const targetCommit = isNoCommit(ref.remoteSha) ? undefined : ref.remoteSha;
    const rules = withTier(policyOf({ branch, commit: ref.localSha, targetCommit }), branch);
    if (!rules.ok) return { kind: 'error', name: branch, errors: rules.errors };
    const { policy, source, tier } = rules;
    if (tier === undefined) {
      return { kind: 'skip', name: branch, reason: 'the policy sets no level for this branch' };
    }

    // The plain case, the policy that is already on the branch, is not spelled out on every push.
    const notes = source.kind === 'own' ? policyLines(source) : policyWords(source).notes;
    return { kind: 'check', branch, commit: ref.localSha, level: tier.level, policy, source, notes };
  });
}

/**
 * The policy a pushed commit is judged by. Git tells the hook which commit each branch points
 * to on the remote right now, and the policy is read from that commit. So it is the remote's
 * own, not what this clone remembers of it.
 */
function policyOnTheRemote(root: string, { branch, commit, targetCommit }: Entering): PolicyChoice {
  if (!hasCommit(root, commit)) {
    return { ok: false, errors: [`this clone does not hold commit ${shortId(commit)}, which the push names`] };
  }
  if (targetCommit !== undefined && !hasCommit(root, targetCommit)) {
    return {
      ok: false,
      errors: [
        `"${branch}" on the remote is at commit ${shortId(targetCommit)}, which this clone does not hold, so its policy cannot be read. Run "git fetch" and push again`,
      ],
    };
  }
  return policyFor(root, commit, { branch, commit: targetCommit, shown: `"${branch}" on the remote` });
}

// --- 2. judge ---

type CheckStep = Extract<PushStep, { kind: 'check' }>;

/** A pushed commit that needs a record, with what it has to show. */
type Judged = CheckStep & { readonly proof: Proof };

function judge(root: string, step: CheckStep, now: number): Judged {
  return { ...step, proof: proofOf(root, step, { commit: step.commit, level: step.level, branch: step.branch, now }) };
}

// --- 3. report ---

/** The lines about one judged commit: the verdict on its record, then everything there is to say, moved in under it. */
function linesOf(judged: Judged): string[] {
  const { record, unreadable, approval } = judged.proof;
  const verdict = record.ok ? `PASS (${passedRecord(record)})` : `REFUSED (${record.summary})`;
  const under = [...judged.notes, ...(record.ok ? [] : record.details), ...unreadable.map(ignoredLine), ...approvalLines(approval)];
  return [
    `  ${judged.branch}: commit ${shortId(judged.commit)} needs level ${judged.level}: ${verdict}`,
    ...under.map((line) => `      ${line}`),
  ];
}

/** "the pushed commit has no valid record", or "2 of 3 pushed commits have no valid record". */
function lacking(count: number, total: number, what: string): string {
  if (total === 1) return `the pushed commit has no valid ${what}`;
  return `${count} of ${total} pushed commits ${count === 1 ? 'has' : 'have'} no valid ${what}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// --- 4. send ---

/**
 * When the policy says records and approvals travel, what opened this door goes to the remote
 * with the push, so that the check on the remote's side finds it. Sending is not a check: when
 * it fails the push still goes on, and the line says how to send it afterwards.
 */
function send(root: string, io: Io, passed: readonly Judged[], remote: string | undefined, now: number): void {
  for (const step of passed) {
    if (step.policy.travel !== true) continue;
    // Git gives the hook the remote as its first argument. A hook file that does not pass it
    // on leaves the tool without it. Then nothing can be sent, and that is said, not passed over.
    const sent: Sent =
      remote === undefined
        ? { kind: 'error', reason: 'the hook was not told which remote the push goes to' }
        : sendReceipts(root, remote, step.commit, now);
    if (sent.kind === 'sent') io.out(`  ${step.branch}: sent to the remote: ${countOf(sent.sent)}`);
    if (sent.kind === 'error') {
      io.out(`  ${step.branch}: NOT SENT to the remote: ${sent.reason}`);
      io.out(`      Send it after the push: gotreceipts send ${shortId(step.commit)}`);
    }
  }
}

/**
 * `input` is what git wrote to the hook, and `now` is the current time in milliseconds.
 * `remote` is the remote git is pushing to, by its name or its address.
 */
export function prePush(input: string, io: Io, now: number, remote?: string): ExitCode {
  const cannotCheck = (reasons: readonly string[]): ExitCode => {
    for (const reason of reasons) io.err(`gotreceipts pre-push: CANNOT CHECK: ${reason}`);
    io.err('The push is blocked. A check that could not run is never treated as a pass.');
    return EXIT.CANNOT_RUN;
  };

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotCheck(['this folder is not inside a git repository']);

  const parsed = parsePushLines(input);
  if (!parsed.ok) return cannotCheck([parsed.error]);

  // 1. Plan. A policy that could not be read blocks the whole push.
  const steps = planPush(parsed.refs, (entering) => policyOnTheRemote(root, entering));
  const errors = steps.flatMap((step) => (step.kind === 'error' ? step.errors.map((error) => `${step.name}: ${error}`) : []));
  if (errors.length > 0) return cannotCheck(errors);

  // 2. Judge, before anything is printed. An approval that cannot be checked blocks the whole
  //    push, like every other "could not check" of this hook.
  const seen = steps.map((step) => (step.kind === 'check' ? judge(root, step, now) : step));
  const judged = seen.filter((step) => step.kind === 'check');
  const unchecked = judged.flatMap(({ branch, proof: { approval } }) =>
    approval.kind === 'cannot-check' ? [`${branch}: ${approvalNotChecked(approval.reason)}`] : [],
  );
  if (unchecked.length > 0) return cannotCheck(unchecked);

  // 3. Report, in the order git named the pushed things.
  io.out(`gotreceipts pre-push: ${plural(judged.length, 'branch', 'branches')} to check`);
  for (const step of seen) {
    if (step.kind === 'skip') io.out(`  ${step.name}: not checked (${step.reason})`);
    if (step.kind === 'check') for (const line of linesOf(step)) io.out(line);
  }

  const withoutRecord = judged.filter((step) => !step.proof.record.ok);
  const withoutApproval = judged.filter((step) => step.proof.approval.kind === 'refused');

  if (withoutRecord.length === 0 && withoutApproval.length === 0) {
    // 4. Send.
    send(root, io, judged, remote, now);
    io.out(
      judged.length === 0
        ? 'VERDICT: PASS (nothing in this push needs a record)'
        : `VERDICT: PASS (${plural(judged.length, 'pushed commit has', 'pushed commits have')} a valid record)`,
    );
    return EXIT.PASS;
  }

  const what = [
    ...(withoutRecord.length > 0 ? [lacking(withoutRecord.length, judged.length, 'record')] : []),
    ...(withoutApproval.length > 0 ? [lacking(withoutApproval.length, judged.length, 'approval')] : []),
  ].join(', and ');
  io.out(`VERDICT: REFUSED (${what}). Nothing was pushed.`);
  if (withoutRecord.length > 0) {
    const checkedOut = headCommit(root);
    io.out('To make a record:');
    for (const step of withoutRecord) io.out(`  ${gateAdvice(step.branch, step.commit, checkedOut)}`);
  }
  if (withoutApproval.length > 0) {
    for (const line of approvalAdvice(...withoutApproval)) io.out(line);
  }
  return EXIT.REFUSED;
}
