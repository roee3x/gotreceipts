import { git, obtainCommit, remoteRefCommit, remotes } from '../git.ts';
import { keepReceipts, localReceipts } from './local.ts';
import { filesOfCommit, writeCommit } from './objects.ts';
import { mergeReceipts, notFromTheFuture, receiptsRef, sortIntoReceipts, type Receipt } from './receipt.ts';

/**
 * The remote side of records and approvals that travel: asking a remote what it holds for one
 * commit, adding to it, and taking from it.
 */

type Remote = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string };

/** The remote to use when none is named: "origin", or the only one there is. */
export function pickRemote(root: string, named: string | undefined): Remote {
  const all = remotes(root).map((remote) => remote.name);
  if (named !== undefined) {
    return all.includes(named) ? { ok: true, name: named } : { ok: false, reason: `this repository has no remote "${named}"` };
  }
  if (all.length === 0) return { ok: false, reason: 'this repository has no remote' };
  if (all.includes('origin')) return { ok: true, name: 'origin' };
  if (all.length === 1 && all[0] !== undefined) return { ok: true, name: all[0] };
  return { ok: false, reason: `say which remote, with --remote (this repository has: ${all.join(', ')})` };
}

/** The first line of what git said that is not empty. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

export type Held =
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly receiptsCommit: string; readonly receipts: readonly Receipt[] }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * What the remote holds for one commit, asked from the remote itself.
 *
 * Only files that are exactly what they should be come back. Whatever else was put under the
 * name is not looked at.
 */
export function remoteReceipts(root: string, remote: string, commit: string, now: number): Held {
  const error = (reason: string): Held => ({ kind: 'error', reason });
  const ref = receiptsRef(commit);

  const asked = remoteRefCommit(root, remote, ref);
  if (!asked.ok) return error(firstLine(asked.stderr) || `the remote "${remote}" did not answer`);
  const receiptsCommit = asked.commit;
  if (receiptsCommit === undefined) return { kind: 'none' };

  if (!obtainCommit(root, remote, ref, receiptsCommit)) {
    return error(`what the remote "${remote}" holds for this commit could not be downloaded`);
  }
  const files = filesOfCommit(root, receiptsCommit);
  if (files === undefined) return error(`what the remote "${remote}" holds for this commit could not be read`);
  return { kind: 'found', receiptsCommit, receipts: notFromTheFuture(sortIntoReceipts(commit, files), now) };
}

export type Sent =
  /** This clone holds no record and no approval of the commit. */
  | { readonly kind: 'nothing' }
  /** The remote already held everything this clone has. */
  | { readonly kind: 'already'; readonly held: readonly Receipt[] }
  | { readonly kind: 'sent'; readonly sent: readonly Receipt[]; readonly held: readonly Receipt[] }
  | { readonly kind: 'error'; readonly reason: string };

/** How often the sending starts over when someone else sent in the same moment. */
const ATTEMPTS = 3;
/** What git says when a push is refused because the remote moved in between. Only that is worth another try. */
const REMOTE_MOVED = /fetch first|non-fast-forward|stale info/;

/**
 * Sends what this clone holds for one commit to the remote.
 *
 * It adds to what the remote holds and takes nothing away: the new small commit has the remote's
 * last one as its parent, and git refuses the push when the remote moved in between. Then the
 * sending starts over with what the remote holds now.
 */
export function sendReceipts(root: string, remote: string, commit: string, now: number): Sent {
  const mine = localReceipts(root, commit);
  if (mine.length === 0) return { kind: 'nothing' };

  let lastError = '';
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const theirs = remoteReceipts(root, remote, commit, now);
    if (theirs.kind === 'error') return theirs;
    const before = theirs.kind === 'found' ? theirs.receipts : [];
    const merged = mergeReceipts(before, mine);
    if (merged.gained.length === 0) return { kind: 'already', held: before };

    const made = writeCommit(root, commit, merged.all, theirs.kind === 'found' ? theirs.receiptsCommit : undefined);
    if (made === undefined) return { kind: 'error', reason: 'git could not write the records into the repository' };

    // "--no-verify": this push carries records, no code. The push hooks of the clone are for
    // commits that enter a branch, and this name is not a branch.
    const pushed = git(['push', '--quiet', '--no-verify', remote, `${made}:${receiptsRef(commit)}`], root);
    if (pushed.ok) return { kind: 'sent', sent: merged.gained, held: merged.all };
    lastError = firstLine(pushed.stderr.replace(/^To .*$/m, '')) || 'the push was refused';
    if (!REMOTE_MOVED.test(pushed.stderr)) break;
  }
  return { kind: 'error', reason: lastError };
}

export type Got =
  | { readonly kind: 'none' }
  /** `gained` is what this clone lacked, or held an older copy of. It can be empty. */
  | { readonly kind: 'got'; readonly gained: readonly Receipt[]; readonly held: readonly Receipt[] }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Takes from the remote what this clone lacks for one commit, and puts it where the doors look.
 *
 * Nothing is believed here. A fetched record is judged at the door exactly like one made in this
 * clone, and a fetched approval counts only for its signature.
 */
export function fetchReceipts(root: string, remote: string, commit: string, now: number): Got {
  const theirs = remoteReceipts(root, remote, commit, now);
  if (theirs.kind !== 'found') return theirs;
  const merged = mergeReceipts(localReceipts(root, commit), theirs.receipts);
  if (merged.gained.length > 0 && !keepReceipts(root, commit, merged.gained)) {
    return { kind: 'error', reason: 'what was fetched could not be written into the .git folder' };
  }
  return { kind: 'got', gained: merged.gained, held: theirs.receipts };
}
