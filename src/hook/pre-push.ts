import { approvalLines, judgeApproval, type ApprovalDecision } from '../approval/judge.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { hasCommit, headCommit, repoRoot } from '../git.ts';
import type { Io } from '../main.ts';
import { policyFor, sourceLines, type PolicyChoice, type PolicySource } from '../policy/committed.ts';
import { tierForBranch, type Policy } from '../policy/policy.ts';
import { countOf } from '../travel/receipts.ts';
import { sendReceipts } from '../travel/remote.ts';
import { shownAge } from '../verify/decide.ts';
import { judgeCommit } from '../verify/judge.ts';

/** What git writes in place of a commit id when there is none: a deleted or a new branch. */
const NO_COMMIT = /^0+$/;
const BRANCH_PREFIX = 'refs/heads/';

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
      !/^[0-9a-f]{40,64}$/.test(localSha) ||
      !/^[0-9a-f]{40,64}$/.test(remoteSha)
    ) {
      return { ok: false, error: `git gave a line this hook does not understand: "${trimmed}"` };
    }
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return { ok: true, refs };
}

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
    if (NO_COMMIT.test(ref.localSha)) {
      return { kind: 'skip', name: branch, reason: 'the branch is being deleted, so no commit enters it' };
    }
    const targetCommit = NO_COMMIT.test(ref.remoteSha) ? undefined : ref.remoteSha;
    const picked = policyOf({ branch, commit: ref.localSha, targetCommit });
    if (!picked.ok) return { kind: 'error', name: branch, errors: picked.errors };

    const tier = tierForBranch(picked.policy, branch);
    if (tier === undefined) {
      return { kind: 'skip', name: branch, reason: 'the policy sets no level for this branch' };
    }
    // The plain case, the policy that is already on the branch, is not spelled out on every push.
    const [first = '', ...more] = sourceLines(picked.source);
    const notes = picked.source.kind === 'own' ? [`policy: ${first}`] : more;
    return { kind: 'check', branch, commit: ref.localSha, level: tier.level, policy: picked.policy, source: picked.source, notes };
  });
}

/** "the pushed commit has no valid record", or "2 of 3 pushed commits have no valid record". */
function lacking(count: number, total: number, what: string): string {
  if (total === 1) return `the pushed commit has no valid ${what}`;
  return `${count} of ${total} pushed commits ${count === 1 ? 'has' : 'have'} no valid ${what}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The pre-push hook. Git calls it before a push and gives it, as text, what the push would change.
 * Every commit that would enter a branch with a level must have a valid record at that level.
 * If one does not, the whole push is refused.
 *
 * The level and the checks come from the policy that is already on the branch on the remote.
 * A commit that edits the policy file is still judged by the policy it found there.
 *
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

  // Git tells the hook which commit each branch points to on the remote right now. The policy
  // is read from that commit, so it is the remote's own, not what this clone remembers of it.
  const steps = planPush(parsed.refs, ({ branch, commit, targetCommit }): PolicyChoice => {
    if (!hasCommit(root, commit)) {
      return { ok: false, errors: [`this clone does not hold commit ${commit.slice(0, 7)}, which the push names`] };
    }
    if (targetCommit !== undefined && !hasCommit(root, targetCommit)) {
      return {
        ok: false,
        errors: [
          `"${branch}" on the remote is at commit ${targetCommit.slice(0, 7)}, which this clone does not hold, so its policy cannot be read. Run "git fetch" and push again`,
        ],
      };
    }
    return policyFor(root, commit, { branch, commit: targetCommit, shown: `"${branch}" on the remote` });
  });

  const errors = steps.flatMap((step) => (step.kind === 'error' ? step.errors.map((error) => `${step.name}: ${error}`) : []));
  if (errors.length > 0) return cannotCheck(errors);

  const toCheck = steps.filter((step) => step.kind === 'check');

  // The approvals are judged before anything is printed. One that cannot be checked blocks the
  // whole push, like every other "could not check" of this hook.
  const approvals = new Map(toCheck.map((step) => [step, judgeApproval(root, step.policy, step.source, step.commit, step.branch, now)]));
  const unchecked = [...approvals].flatMap(([step, approval]) =>
    approval.kind === 'cannot-check' ? [`${step.branch}: the approval could not be checked: ${approval.reason}`] : [],
  );
  if (unchecked.length > 0) return cannotCheck(unchecked);

  io.out(`gotreceipts pre-push: ${plural(toCheck.length, 'branch', 'branches')} to check`);

  const head = headCommit(root);
  const recordAdvice: string[] = [];
  const approvalNeeded: string[] = [];
  let withoutRecord = 0;
  let withoutApproval = 0;

  for (const step of steps) {
    if (step.kind === 'error') continue;
    if (step.kind === 'skip') {
      io.out(`  ${step.name}: not checked (${step.reason})`);
      continue;
    }
    const shortCommit = step.commit.slice(0, 7);
    const { decision, unreadable } = judgeCommit(root, step.policy, step.commit, step.level, now);
    const approval: ApprovalDecision = approvals.get(step) ?? { kind: 'not-needed' };
    const subject = `  ${step.branch}: commit ${shortCommit} needs level ${step.level}`;

    if (decision.ok) {
      io.out(`${subject}: PASS (${decision.record.level} record, passed ${shownAge(decision.ageHours)} hours ago)`);
      for (const note of step.notes) io.out(`      ${note}`);
    } else {
      withoutRecord += 1;
      io.out(`${subject}: REFUSED (${decision.summary})`);
      for (const note of step.notes) io.out(`      ${note}`);
      for (const detail of decision.details) io.out(`      ${detail}`);
      const command = `gotreceipts gate --for ${step.branch}`;
      recordAdvice.push(step.commit === head ? `  ${command}` : `  ${command}   (with commit ${shortCommit} checked out)`);
    }
    for (const file of unreadable) io.out(`      ignored, not a valid record: ${file}`);

    for (const line of approvalLines(approval)) io.out(`      ${line}`);
    if (approval.kind === 'refused') {
      withoutApproval += 1;
      approvalNeeded.push(`  gotreceipts approve ${shortCommit} --for ${step.branch}`);
    }
  }

  if (withoutRecord === 0 && withoutApproval === 0) {
    // When the policy says records and approvals travel, what opened this door goes to the
    // remote with the push, so that the check on the remote's side finds it. Sending is not a
    // check: when it fails the push still goes on, and the line says how to send it afterwards.
    for (const step of toCheck) {
      if (step.policy.travel !== true || remote === undefined) continue;
      const sent = sendReceipts(root, remote, step.commit, now);
      if (sent.kind === 'sent') io.out(`  ${step.branch}: sent to the remote: ${countOf(sent.sent)}`);
      if (sent.kind === 'error') {
        io.out(`  ${step.branch}: NOT SENT to the remote: ${sent.reason}`);
        io.out(`      Send it after the push: gotreceipts send ${step.commit.slice(0, 7)}`);
      }
    }
    io.out(
      toCheck.length === 0
        ? 'VERDICT: PASS (nothing in this push needs a record)'
        : `VERDICT: PASS (${plural(toCheck.length, 'pushed commit has', 'pushed commits have')} a valid record)`,
    );
    return EXIT.PASS;
  }

  const what = [
    ...(withoutRecord > 0 ? [lacking(withoutRecord, toCheck.length, 'record')] : []),
    ...(withoutApproval > 0 ? [lacking(withoutApproval, toCheck.length, 'approval')] : []),
  ].join(', and ');
  io.out(`VERDICT: REFUSED (${what}). Nothing was pushed.`);
  if (withoutRecord > 0) {
    io.out('To make a record:');
    for (const line of recordAdvice) io.out(line);
  }
  if (withoutApproval > 0) {
    io.out('An approval is the signature of an owner. They give it in their own terminal:');
    for (const line of approvalNeeded) io.out(line);
  }
  return EXIT.REFUSED;
}
