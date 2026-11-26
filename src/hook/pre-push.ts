import { EXIT, type ExitCode } from '../exit-codes.ts';
import { headCommit } from '../git.ts';
import type { Io } from '../main.ts';
import { loadPolicy } from '../policy/load.ts';
import { tierForBranch, type Policy } from '../policy/policy.ts';
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

/** What the hook will do about one pushed ref. */
export type PushStep =
  | { readonly kind: 'check'; readonly branch: string; readonly commit: string; readonly level: string }
  | { readonly kind: 'skip'; readonly name: string; readonly reason: string };

/**
 * Decides, for every pushed ref, whether it needs a record and at which level.
 *
 * Only a branch the policy names a level for is checked. The policy says which branches are
 * guarded, and the hook does not invent rules of its own.
 */
export function planPush(policy: Policy, refs: readonly PushedRef[]): PushStep[] {
  return refs.map((ref): PushStep => {
    if (!ref.remoteRef.startsWith(BRANCH_PREFIX)) {
      return { kind: 'skip', name: ref.remoteRef, reason: 'not a branch' };
    }
    const branch = ref.remoteRef.slice(BRANCH_PREFIX.length);
    if (NO_COMMIT.test(ref.localSha)) {
      return { kind: 'skip', name: branch, reason: 'the branch is being deleted, so no commit enters it' };
    }
    const tier = tierForBranch(policy, branch);
    if (tier === undefined) {
      return { kind: 'skip', name: branch, reason: 'the policy sets no level for this branch' };
    }
    return { kind: 'check', branch, commit: ref.localSha, level: tier.level };
  });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The pre-push hook. Git calls it before a push and gives it, as text, what the push would change.
 * Every commit that would enter a branch with a level must have a valid record at that level.
 * If one does not, the whole push is refused.
 *
 * `input` is what git wrote to the hook, and `now` is the current time in milliseconds.
 */
export function prePush(input: string, io: Io, now: number): ExitCode {
  const cannotCheck = (reasons: readonly string[]): ExitCode => {
    for (const reason of reasons) io.err(`gotreceipts pre-push: CANNOT CHECK: ${reason}`);
    io.err('The push is blocked. A check that could not run is never treated as a pass.');
    return EXIT.CANNOT_RUN;
  };

  const loaded = loadPolicy(process.cwd());
  if (!loaded.ok) return cannotCheck(loaded.errors);
  const { policy, root } = loaded;
  if (root === undefined) return cannotCheck(['this folder is not inside a git repository']);

  const parsed = parsePushLines(input);
  if (!parsed.ok) return cannotCheck([parsed.error]);

  const steps = planPush(policy, parsed.refs);
  const toCheck = steps.filter((step) => step.kind === 'check');
  io.out(`gotreceipts pre-push: ${plural(toCheck.length, 'branch', 'branches')} to check`);

  const head = headCommit(root);
  const advice: string[] = [];
  let refused = 0;

  for (const step of steps) {
    if (step.kind === 'skip') {
      io.out(`  ${step.name}: not checked (${step.reason})`);
      continue;
    }
    const shortCommit = step.commit.slice(0, 7);
    const { decision, unreadable } = judgeCommit(root, policy, step.commit, step.level, now);
    const subject = `  ${step.branch}: commit ${shortCommit} needs level ${step.level}`;

    if (decision.ok) {
      io.out(`${subject}: PASS (${decision.record.level} record, passed ${shownAge(decision.ageHours)} hours ago)`);
    } else {
      refused += 1;
      io.out(`${subject}: REFUSED (${decision.summary})`);
      for (const detail of decision.details) io.out(`      ${detail}`);
      const command = `gotreceipts gate --for ${step.branch}`;
      advice.push(step.commit === head ? `  ${command}` : `  ${command}   (with commit ${shortCommit} checked out)`);
    }
    for (const file of unreadable) io.out(`      ignored, not a valid record: ${file}`);
  }

  if (refused === 0) {
    io.out(
      toCheck.length === 0
        ? 'VERDICT: PASS (nothing in this push needs a record)'
        : `VERDICT: PASS (${plural(toCheck.length, 'pushed commit has', 'pushed commits have')} a valid record)`,
    );
    return EXIT.PASS;
  }

  const what =
    toCheck.length === 1
      ? 'the pushed commit has no valid record'
      : `${refused} of ${toCheck.length} pushed commits ${refused === 1 ? 'has' : 'have'} no valid record`;
  io.out(`VERDICT: REFUSED (${what}). Nothing was pushed.`);
  io.out('To make a record:');
  for (const line of advice) io.out(line);
  return EXIT.REFUSED;
}
