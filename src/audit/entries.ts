import { git } from '../git.ts';

/**
 * What entered a branch, read from its history.
 *
 * A branch has a line of its own: the commit it points to, the commit it pointed to before
 * that, and so on. In git this is the chain of first parents. Everything else in the history
 * came in from the side, through a merge.
 *
 * An entry is one thing that moved the branch:
 *
 *   - a merge commit. What entered is the commit that was merged in, its second parent.
 *   - one or more commits that were pushed straight onto the branch. They count as one push,
 *     and what entered is the newest of them, the way the push hook saw it.
 */

/** One commit on the branch's own line, with all of its parents. */
export interface Step {
  readonly commit: string;
  readonly parents: readonly string[];
}

export interface Entry {
  /** "many-parents": more than two lines of history meet in one commit. */
  readonly kind: 'merge' | 'push' | 'many-parents';
  /** The commit on the branch: the merge commit, or the newest of the pushed commits. */
  readonly on: string;
  /** What the branch pointed to before. Undefined when the history of the branch starts here. */
  readonly before: string | undefined;
  /** The commit that had to bring its record, and its approval when one was needed. */
  readonly entered: string;
  /** How many commits of the branch's own line the entry spans. 1 for a merge. */
  readonly commits: number;
}

/** Groups the branch's own line into entries. `steps` and the result are newest first. */
export function entriesOf(steps: readonly Step[]): Entry[] {
  const entries: Entry[] = [];
  let index = 0;
  while (index < steps.length) {
    const step = steps[index];
    if (step === undefined) break;
    if (step.parents.length >= 2) {
      const merged = step.parents[1];
      entries.push({
        kind: step.parents.length === 2 ? 'merge' : 'many-parents',
        on: step.commit,
        before: step.parents[0],
        entered: step.parents.length === 2 && merged !== undefined ? merged : step.commit,
        commits: 1,
      });
      index += 1;
      continue;
    }
    // A run of commits that each have one parent: pushed straight onto the branch.
    let last = index;
    while ((steps[last + 1]?.parents.length ?? 2) <= 1) last += 1;
    entries.push({ kind: 'push', on: step.commit, before: steps[last]?.parents[0], entered: step.commit, commits: last - index + 1 });
    index = last + 1;
  }
  return entries;
}

export type OwnLine =
  | { readonly ok: true; readonly steps: readonly Step[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the branch's own line from `tip` back.
 *
 * With `since`: every commit after it, and `since` must itself be on that line. When it is not,
 * the branch was rewritten or the wrong commit was named, and that is an error, not an empty answer.
 *
 * Without `since`: only the last entry. That is the newest commit when it is a merge, and else
 * the run of pushed commits that ends at it.
 */
export function ownLine(root: string, tip: string, since: string | undefined): OwnLine {
  const listed = git(['rev-list', '--parents', tip, ...(since === undefined ? [] : [`^${since}`])], root);
  if (!listed.ok) return { ok: false, reason: 'git could not read the history of the branch' };
  const parentsOf = new Map<string, string[]>();
  for (const line of listed.stdout.split('\n')) {
    const [commit, ...parents] = line.trim().split(/\s+/);
    if (commit !== undefined && commit !== '') parentsOf.set(commit, parents);
  }

  const steps: Step[] = [];
  let at: string | undefined = tip;
  while (at !== undefined && at !== since) {
    const parents = parentsOf.get(at);
    if (parents === undefined) break;
    if (since === undefined && steps.length > 0 && parents.length >= 2) break;
    steps.push({ commit: at, parents });
    if (since === undefined && parents.length >= 2) break;
    at = parents[0];
  }
  if (since !== undefined && at !== since) {
    return {
      ok: false,
      reason: `commit ${since.slice(0, 7)} is not on the branch's own line, so what entered after it cannot be told. Was the branch rewritten?`,
    };
  }
  return { ok: true, steps };
}

/** When a commit was made, in milliseconds. For a merge made on the remote, that is when it entered. */
export function commitTime(root: string, commit: string): number | undefined {
  const shown = git(['show', '-s', '--format=%ct', commit], root);
  const seconds = Number(shown.stdout.trim());
  return shown.ok && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** True when the clone holds only part of the history. Then a commit's parents can be missing without a word. */
export function isShallow(root: string): boolean {
  return git(['rev-parse', '--is-shallow-repository'], root).stdout.trim() === 'true';
}
