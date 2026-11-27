import { git, refCommit, remotes } from '../git.ts';
import { policyId } from './hash.ts';
import { parsePolicy } from './parse.ts';
import { POLICY_FILE_NAME, type Policy } from './policy.ts';

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
  return { branch, commit: refCommit(root, `refs/heads/${branch}`), shown: branch };
}

/** Where the policy that was used came from. */
export type PolicySource =
  | {
      readonly kind: 'target';
      readonly shown: string;
      readonly commit: string;
      /** True when the commit that wants in holds another policy than the target does, or none. */
      readonly changedByCommit: boolean;
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
  let because: string | undefined;

  if (target !== undefined) {
    if (target.commit === undefined) {
      because = `"${target.branch}" does not exist yet`;
    } else {
      const onTarget = policyInCommit(root, target.commit);
      if (onTarget.kind === 'invalid') {
        return {
          ok: false,
          errors: onTarget.errors.map((error) => `the policy on ${target.shown} is not valid: ${POLICY_FILE_NAME}: ${error}`),
        };
      }
      if (onTarget.kind === 'policy') {
        const own = target.commit === commit ? onTarget : policyInCommit(root, commit);
        const changedByCommit = own.kind !== 'policy' || policyId(own.policy) !== policyId(onTarget.policy);
        return {
          ok: true,
          policy: onTarget.policy,
          source: { kind: 'target', shown: target.shown, commit: target.commit, changedByCommit },
        };
      }
      because = `${target.shown} holds no policy file yet`;
    }
  }

  const short = commit.slice(0, 7);
  const own = policyInCommit(root, commit);
  if (own.kind === 'none') {
    return { ok: false, errors: [`commit ${short} holds no policy file (${POLICY_FILE_NAME}). Only a committed policy counts`] };
  }
  if (own.kind === 'invalid') {
    return { ok: false, errors: own.errors.map((error) => `commit ${short}: ${POLICY_FILE_NAME}: ${error}`) };
  }
  return { ok: true, policy: own.policy, source: { kind: 'own', commit, because } };
}

/**
 * Says which policy was used, for the output of every command: one line, and a second one
 * when the commit tried to change the policy it is judged by.
 */
export function sourceLines(source: PolicySource): string[] {
  if (source.kind === 'own') {
    return [source.because === undefined ? 'the one in this commit' : `the one in this commit, because ${source.because}`];
  }
  const lines = [`the one on ${source.shown}, at commit ${source.commit.slice(0, 7)}`];
  if (source.changedByCommit) {
    lines.push(`this commit changes the policy file. It is judged by the policy that is already on ${source.shown}`);
  }
  return lines;
}
