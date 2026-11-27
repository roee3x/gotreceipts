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
  /**
   * Set when every commit that enters the branch needs a signed approval, on top of its record.
   * Left out otherwise, so that writing "false" changes nothing.
   */
  readonly needsApproval?: true;
}

/** Someone whose signature counts as an approval. */
export interface Signer {
  readonly name: string;
  /** The public half of an SSH key: its type and its body, without the comment at the end. */
  readonly key: string;
}

export interface Policy {
  readonly schema: 1;
  readonly levels: readonly Level[];
  readonly tiers: readonly Tier[];
  readonly record: {
    /** A record older than this no longer counts. */
    readonly maxAgeHours: number;
  };
  /**
   * Files that are part of the gate itself, as paths from the top of the repository.
   * `*` stands for any run of characters, and a folder stands for everything in it.
   * The policy file is always protected, whether it is listed or not.
   * Left out when the policy lists none, so that writing an empty list changes nothing.
   */
  readonly protected?: readonly string[];
  /**
   * Who may approve, and for how long an approval counts.
   * Left out when the policy lists no signer. Then nothing can ask for an approval:
   * the lock is open until a first key is listed.
   */
  readonly approval?: {
    readonly signers: readonly Signer[];
    /** An approval older than this no longer counts. */
    readonly maxAgeHours: number;
  };
  /**
   * Set when records and approvals travel: the push hook, "approve" and "merge" send them to
   * the remote, and "merge" asks the remote for them. Left out otherwise, so that writing
   * "false" changes nothing. Without it nothing leaves the clone unless a person runs "send".
   */
  readonly travel?: true;
}

export const POLICY_FILE_NAME = 'gotreceipts.json';
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const DEFAULT_MAX_AGE_HOURS = 24;
export const DEFAULT_APPROVAL_HOURS = 24;

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

function escapePattern(pattern: string): string {
  return pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

function patternToRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapePattern(pattern)}$`);
}

/** Every pattern of protected files: the policy file first, then what the policy lists. */
export function protectedPatterns(policy: Pick<Policy, 'protected'>): readonly string[] {
  return [POLICY_FILE_NAME, ...(policy.protected ?? []).filter((pattern) => pattern !== POLICY_FILE_NAME)];
}

/**
 * True when a file is protected. `path` is counted from the top of the repository, with forward slashes.
 *
 * Upper and lower case are not told apart. On Windows and macOS two spellings name one file,
 * and a guard that can be passed by changing a capital letter is no guard. Too wide is the safe side here.
 */
export function isProtectedPath(policy: Pick<Policy, 'protected'>, path: string): boolean {
  return protectedPatterns(policy).some((pattern) => new RegExp(`^${escapePattern(pattern)}(?:/.*)?$`, 'i').test(path));
}

/** The first tier whose pattern matches the branch, or undefined when no tier covers it. */
export function tierForBranch(policy: Policy, branch: string): Tier | undefined {
  return policy.tiers.find((tier) => patternToRegExp(tier.branch).test(branch));
}
