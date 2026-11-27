import { branchRef, differingFiles, git, isAncestor, refCommit, remotes, shortId } from '../git.ts';
import { policyId } from './hash.ts';
import { parsePolicy } from './parse.ts';
import { isProtectedPath, POLICY_FILE_NAME, type Policy } from './policy.ts';

/**
 * Which policy a commit is judged by.
 *
 * The rule: a commit that wants to enter a branch is judged by the policy that is already on
 * that branch. Its own copy of the policy file does not count. So a branch cannot loosen the
 * gate it has to pass, and a change to the policy only takes effect after it passed the old one.
 *
 * Only a committed policy is ever read here. The file in the working folder is not.
 */

/** What reading the policy file out of one commit gave. */
export type CommittedPolicy =
  | { readonly kind: 'policy'; readonly policy: Policy }
  /** The commit holds no policy file. */
  | { readonly kind: 'none' }
  /** The commit holds a policy file that is not valid. */
  | { readonly kind: 'invalid'; readonly errors: readonly string[] };

/** Reads gotreceipts.json as it is committed in `commit`. */
export function policyInCommit(root: string, commit: string): CommittedPolicy {
  const file = `${commit}:${POLICY_FILE_NAME}`;
  if (!git(['cat-file', '-e', file], root).ok) return { kind: 'none' };
  const content = git(['cat-file', 'blob', file], root);
  if (!content.ok) return { kind: 'invalid', errors: ['git could not read it as a file'] };
  const parsed = parsePolicy(content.stdout);
  if (!parsed.ok) return { kind: 'invalid', errors: parsed.errors };
  return { kind: 'policy', policy: parsed.policy };
}

/** A branch a commit wants to enter. */
export interface Target {
  readonly branch: string;
  /** The commit the branch points to. Undefined when the branch does not exist yet. */
  readonly commit: string | undefined;
  /** How the place it was read from is named in the output, for example "origin/main". */
  readonly shown: string;
}

/**
 * Finds a branch the way this clone last saw it: as a remote has it, and only if no remote
 * has it, as it is here. Nothing is downloaded.
 *
 * This is for "gate" and "verify", which work without a network. The push hook and the merge
 * command do not use it: they get the commit of the target branch from the remote itself.
 */
export function knownTarget(root: string, branch: string): Target {
  const names = remotes(root).map((remote) => remote.name);
  const originFirst = [...names.filter((name) => name === 'origin'), ...names.filter((name) => name !== 'origin')];
  for (const remote of originFirst) {
    const commit = refCommit(root, `refs/remotes/${remote}/${branch}`);
    if (commit !== undefined) return { branch, commit, shown: `${remote}/${branch}` };
  }
  return { branch, commit: refCommit(root, branchRef(branch)), shown: branch };
}

/** Where the policy that was used came from. */
export type PolicySource =
  | {
      readonly kind: 'target';
      readonly shown: string;
      readonly commit: string;
      /** True when the commit that wants in holds another policy than the target does, or none. */
      readonly changedByCommit: boolean;
      /**
       * The protected files that would no longer be the same on the target branch if it pointed
       * to this commit. Which files are protected is said by the target's policy.
       */
      readonly protectedChanged: readonly string[];
      /**
       * True when the target holds commits that this commit does not. Then a file in the list
       * above may differ because of a change on the target, and not one made by this commit.
       */
      readonly behindTarget: boolean;
    }
  | {
      readonly kind: 'own';
      readonly commit: string;
      /** Why the target's policy was not used. Undefined when no target was named. */
      readonly because: string | undefined;
    };

export type PolicyChoice =
  | { readonly ok: true; readonly policy: Policy; readonly source: PolicySource }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Picks the policy `commit` is judged by.
 *
 * With a target that exists and holds a policy, it is the target's.
 * Otherwise it is the policy in the commit itself: when no target is named, when the target
 * branch does not exist yet, or when it holds no policy file yet. A new branch has no policy
 * of its own, and the first policy of a repository has to get in somehow.
 *
 * A target whose policy is not valid is an error and never falls back to the commit's own.
 * Otherwise a branch could break the policy on purpose to get rid of it.
 */
export function policyFor(root: string, commit: string, target: Target | undefined): PolicyChoice {
  if (target === undefined) return fromTheCommitItself(root, commit, undefined);
  if (target.commit === undefined) return fromTheCommitItself(root, commit, `"${target.branch}" does not exist yet`);

  const onTarget = policyInCommit(root, target.commit);
  switch (onTarget.kind) {
    case 'invalid':
      return {
        ok: false,
        errors: onTarget.errors.map((error) => `the policy on ${target.shown} is not valid: ${POLICY_FILE_NAME}: ${error}`),
      };
    case 'none':
      return fromTheCommitItself(root, commit, `${target.shown} holds no policy file yet`);
    case 'policy':
      return fromTheTarget(root, commit, { commit: target.commit, shown: target.shown }, onTarget.policy);
  }
}

/** The usual case: the target branch holds a policy, and that one counts. */
function fromTheTarget(
  root: string,
  commit: string,
  target: { readonly commit: string; readonly shown: string },
  policy: Policy,
): PolicyChoice {
  const isTheTarget = target.commit === commit;

  const own = isTheTarget ? undefined : policyInCommit(root, commit);
  const changedByCommit = own !== undefined && (own.kind !== 'policy' || policyId(own.policy) !== policyId(policy));

  // The two commits are compared file by file, not through their history. So a commit that
  // takes the branch back to an older state of a protected file is seen as well.
  const differing = isTheTarget ? [] : differingFiles(root, target.commit, commit);
  if (differing === undefined) {
    return {
      ok: false,
      errors: [`git could not compare commit ${shortId(commit)} with ${target.shown}, so the protected files could not be checked`],
    };
  }
  const protectedChanged = differing.filter((path) => isProtectedPath(policy, path));
  const behindTarget = protectedChanged.length > 0 && !isAncestor(root, target.commit, commit);

  return {
    ok: true,
    policy,
    source: { kind: 'target', shown: target.shown, commit: target.commit, changedByCommit, protectedChanged, behindTarget },
  };
}

/**
 * The other case: there is no policy on a target to judge by, so the commit's own counts.
 * `because` says why, for the output. Undefined when no target was named at all.
 */
function fromTheCommitItself(root: string, commit: string, because: string | undefined): PolicyChoice {
  const own = policyInCommit(root, commit);
  switch (own.kind) {
    case 'none':
      return { ok: false, errors: [`commit ${shortId(commit)} holds no policy file (${POLICY_FILE_NAME}). Only a committed policy counts`] };
    case 'invalid':
      return { ok: false, errors: own.errors.map((error) => `commit ${shortId(commit)}: ${POLICY_FILE_NAME}: ${error}`) };
    case 'policy':
      return { ok: true, policy: own.policy, source: { kind: 'own', commit, because } };
  }
}

/**
 * Says which policy was used, for the output of every command: one line, then a line when the
 * commit tried to change the policy it is judged by, and a line that names the protected files
 * that would change on the target.
 */
export function sourceLines(source: PolicySource): string[] {
  if (source.kind === 'own') {
    return [source.because === undefined ? 'the one in this commit' : `the one in this commit, because ${source.because}`];
  }
  const lines = [`the one on ${source.shown}, at commit ${shortId(source.commit)}`];
  if (source.changedByCommit) {
    lines.push(`this commit changes the policy file. It is judged by the policy that is already on ${source.shown}`);
  }
  if (source.protectedChanged.length > 0) {
    lines.push(protectedLine(source.protectedChanged, source.shown));
    if (source.behindTarget) {
      lines.push(`${source.shown} holds commits this one does not, so a file may be listed because of a change made there`);
    }
  }
  return lines;
}

/** How many names of protected files are written out before the rest is only counted. */
const NAMES_SHOWN = 5;

/**
 * "1 protected file is not the same as on origin/main: a", or
 * "7 protected files are not the same as on origin/main: a, b, c, d, e and 2 more".
 *
 * The wording is about the two states, not about who changed what. That is all a comparison
 * of two commits can say, and it is what matters: the file would change on the target branch.
 */
export function protectedLine(files: readonly string[], shown: string): string {
  const names = files.slice(0, NAMES_SHOWN).join(', ');
  const rest = files.length > NAMES_SHOWN ? ` and ${files.length - NAMES_SHOWN} more` : '';
  const count = files.length === 1 ? '1 protected file is' : `${files.length} protected files are`;
  return `${count} not the same as on ${shown}: ${names}${rest}`;
}
