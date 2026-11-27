import { obtainCommit, remoteBranch, remotes, shortId } from '../git.ts';
import type { Target } from '../policy/committed.ts';
import { repositoryOf, viewPullRequest, type PullRequest } from './github.ts';

/**
 * A pull request, as a question for the door: which commit, into which branch, and where
 * that branch is now.
 *
 * "merge" and "approve --pr" both start from the number of a pull request, and both need the
 * same things before anything can be judged. They are here, once.
 */

/** The number of a pull request as a person types it, "12" or "#12". Undefined for anything else. */
export function pullRequestNumber(typed: string | undefined): number | undefined {
  const digits = typed?.replace(/^#/, '');
  return digits !== undefined && /^[1-9]\d*$/.test(digits) ? Number(digits) : undefined;
}

export type PullRequestNow = { readonly ok: true; readonly pullRequest: PullRequest } | { readonly ok: false; readonly reason: string };

/** The pull request as GitHub has it now. */
export function pullRequestNow(root: string, number: number): PullRequestNow {
  const viewed = viewPullRequest(root, number);
  if (!viewed.ok) return { ok: false, reason: `GitHub could not be asked about pull request #${number}: ${viewed.error}` };
  return { ok: true, pullRequest: viewed.value };
}

/** Says that a pull request is merged or closed. Undefined when it is open. */
export function whyNotOpen(pullRequest: PullRequest): string | undefined {
  if (pullRequest.state === 'OPEN') return undefined;
  return `pull request #${pullRequest.number} is not open: GitHub shows it as ${pullRequest.state.toLowerCase()}`;
}

/** The remote that holds the pull request's repository: the one whose address names it, else "origin". */
export function remoteFor(root: string, pullRequestUrl: string): string | undefined {
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

export type PullRequestTarget =
  | {
      readonly ok: true;
      /** The remote the pull request lives on. */
      readonly remote: string;
      /** Its target branch, at the commit the remote has it at now. */
      readonly target: Target & { readonly commit: string };
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Finds the target branch of a pull request as the remote has it now, and makes sure this
 * clone holds both commits: the newest one of the target, and the one the pull request would merge.
 *
 * The target is asked from the remote itself, not taken from what this clone remembers of it.
 */
export function targetOf(root: string, pullRequest: PullRequest): PullRequestTarget {
  const no = (reason: string): PullRequestTarget => ({ ok: false, reason });
  const { baseRefName: base, headRefOid: commit, number } = pullRequest;

  const remote = remoteFor(root, pullRequest.url);
  if (remote === undefined) return no('this repository has no remote, so the target branch cannot be read');

  const onRemote = remoteBranch(root, remote, base);
  if (onRemote.kind === 'unknown') return no(`the remote "${remote}" could not say where "${base}" is now`);
  if (onRemote.kind === 'not-downloaded') return no(`the newest commit of "${base}" could not be downloaded`);

  if (!obtainCommit(root, remote, `refs/pull/${number}/head`, commit)) {
    return no(`commit ${shortId(commit)} of the pull request could not be downloaded`);
  }
  return { ok: true, remote, target: { branch: base, commit: onRemote.commit, shown: `${remote}/${base}` } };
}
