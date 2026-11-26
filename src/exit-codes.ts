/**
 * The three exit codes every command uses.
 *
 * "Could not run" is its own code on purpose. A check that did not run
 * must never be mistaken for a check that passed.
 */
export const EXIT = {
  /** The command ran and the answer is yes. */
  PASS: 0,
  /** The command ran and the answer is no. */
  REFUSED: 1,
  /** The command could not run, or was not understood. Never a pass. */
  CANNOT_RUN: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
