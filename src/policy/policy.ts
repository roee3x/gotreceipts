/**
 * The policy: what the gate runs, and which branch needs which level.
 * It lives in gotreceipts.json at the top of the repository.
 */

/** A number the output must show, for example the count of tests that ran. */
export interface ExpectCount {
  /** A regular expression whose first group captures the number. */
  readonly pattern: string;
  /** The smallest number that passes. */
  readonly atLeast: number;
}

/** What a check's output must show, on top of exit code 0. */
export interface Expect {
  /** A regular expression the output must contain, for example a verdict line. */
  readonly output?: string;
  readonly count?: ExpectCount;
}

/** One command the gate runs. */
export interface Check {
  readonly name: string;
  /** The command line, run through the system shell. */
  readonly run: string;
  /** A check that runs longer than this fails. */
  readonly timeoutMinutes: number;
  readonly expect: Expect;
}

/**
 * A gate level. Levels are ordered, and each level includes every check of the levels before it.
 * `checks` holds only the checks this level adds.
 */
export interface Level {
  readonly name: string;
  readonly checks: readonly Check[];
}

/** A branch pattern and the level a commit needs before it may enter that branch. */
export interface Tier {
  /** A branch name. `*` stands for any run of characters. */
  readonly branch: string;
  readonly level: string;
}

export interface Policy {
  readonly schema: 1;
  readonly levels: readonly Level[];
  readonly tiers: readonly Tier[];
  readonly record: {
    /** A record older than this no longer counts. */
    readonly maxAgeHours: number;
  };
}

export const POLICY_FILE_NAME = 'gotreceipts.json';
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const DEFAULT_MAX_AGE_HOURS = 24;

/** Every check a level runs: its own, and those of every level before it, in order. */
export function checksForLevel(policy: Policy, levelName: string): readonly Check[] | undefined {
  const index = policy.levels.findIndex((level) => level.name === levelName);
  if (index === -1) return undefined;
  return policy.levels.slice(0, index + 1).flatMap((level) => level.checks);
}

/** The position of a level in the order, or -1 when there is no such level. */
export function levelRank(policy: Policy, levelName: string): number {
  return policy.levels.findIndex((level) => level.name === levelName);
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** The first tier whose pattern matches the branch, or undefined when no tier covers it. */
export function tierForBranch(policy: Policy, branch: string): Tier | undefined {
  return policy.tiers.find((tier) => patternToRegExp(tier.branch).test(branch));
}
