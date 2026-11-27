import { checksForLevel, tierForBranch, type Policy } from './policy.ts';

/**
 * Which level a commit needs, as "gate" and "verify" are asked it: by the name of a level
 * (--level), by the branch the commit wants to enter (--for), or, with neither, by the branch
 * that is checked out.
 */
export interface LevelAsk {
  readonly level?: string;
  readonly for?: string;
}

/**
 * The branch the commit is taken to be entering: the one named with --for, else the one that
 * is checked out. With --level no branch is named, so there is none.
 */
export function targetBranch(ask: LevelAsk, checkedOut: string | undefined): string | undefined {
  if (ask.level !== undefined) return undefined;
  return ask.for ?? checkedOut;
}

/** Picks the level, or explains why none could be picked. */
export function chooseLevel(policy: Policy, ask: LevelAsk, checkedOut: string | undefined): { readonly level: string } | { readonly error: string } {
  if (ask.level !== undefined && ask.for !== undefined) return { error: 'give --level or --for, not both' };

  if (ask.level !== undefined) {
    if (checksForLevel(policy, ask.level) !== undefined) return { level: ask.level };
    const levelNames = policy.levels.map((level) => level.name).join(', ');
    return { error: `the policy has no level "${ask.level}" (levels: ${levelNames})` };
  }

  if (ask.for !== undefined) {
    const tier = tierForBranch(policy, ask.for);
    return tier === undefined ? { error: `the policy has no tier for the branch "${ask.for}"` } : { level: tier.level };
  }

  if (checkedOut === undefined) return { error: 'no branch is checked out, so give --level or --for' };
  const tier = tierForBranch(policy, checkedOut);
  return tier === undefined ? { error: `the policy has no tier for the branch "${checkedOut}", so give --level or --for` } : { level: tier.level };
}
