import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from './exit-codes.ts';
import { resolveCommit } from './git.ts';
import type { Io } from './main.ts';

/**
 * How every command starts: it reads what was typed after its name.
 *
 * Every command does this the same way. A word it does not know is "could not run", with the
 * usage text. "--help" prints the usage text and is a pass. And every command reports "could
 * not run" in the same words. So it is written once, here.
 */

/** What a command accepts after its name. */
export interface CommandShape<Value extends string, Switch extends string> {
  /** The command as it is typed, for example "verify". */
  readonly command: string;
  readonly usage: string;
  /** The options that take a value, such as "level" for --level <name>. */
  readonly values?: readonly Value[];
  /** The options that are only switched on, such as "show-words" for --show-words. */
  readonly switches?: readonly Switch[];
  /** True when the command also takes words that are not options, such as a commit. */
  readonly positionals?: boolean;
}

/** The options that were given. One that was not given is not there. */
export type Options<Value extends string, Switch extends string> = { readonly [Name in Value]?: string } & {
  readonly [Name in Switch]?: boolean;
};

/** Reports "could not run", one line per reason, and returns the exit code for it. */
export type CannotRun = (...reasons: readonly string[]) => ExitCode;

export type Start<Value extends string, Switch extends string> =
  /** There is nothing more to do: the help was shown, or what was typed could not be read. */
  | { readonly done: true; readonly code: ExitCode }
  | {
      readonly done: false;
      readonly options: Options<Value, Switch>;
      readonly positionals: readonly string[];
      readonly cannotRun: CannotRun;
    };

export function readOptions<const Value extends string = never, const Switch extends string = never>(
  shape: CommandShape<Value, Switch>,
  args: readonly string[],
  io: Io,
): Start<Value, Switch> {
  const { command, usage } = shape;
  const given: Record<string, string | boolean> = {};
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        ...Object.fromEntries((shape.values ?? []).map((name) => [name, { type: 'string' as const }])),
        ...Object.fromEntries((shape.switches ?? []).map((name) => [name, { type: 'boolean' as const }])),
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: shape.positionals === true,
      strict: true,
    });
    for (const [name, value] of Object.entries(parsed.values)) {
      if (typeof value === 'string' || typeof value === 'boolean') given[name] = value;
    }
    positionals = parsed.positionals;
  } catch (error) {
    io.err(`gotreceipts ${command}: ${error instanceof Error ? error.message : String(error)}`);
    io.err(usage);
    return { done: true, code: EXIT.CANNOT_RUN };
  }

  if (given['help'] === true) {
    io.out(usage);
    return { done: true, code: EXIT.PASS };
  }

  const cannotRun: CannotRun = (...reasons) => {
    for (const reason of reasons) io.err(`gotreceipts ${command}: CANNOT RUN: ${reason}`);
    return EXIT.CANNOT_RUN;
  };
  // The names in `given` are the ones the shape lists: with "strict", any other is an error above.
  return { done: false, options: given as Options<Value, Switch>, positionals, cannotRun };
}

export type AskedCommit = { readonly ok: true; readonly commit: string } | { readonly ok: false; readonly reason: string };

/** The commit a command is about: the one that was named, else the one that is checked out. */
export function commitAskedFor(root: string, named: string | undefined): AskedCommit {
  const wanted = named ?? 'HEAD';
  const commit = resolveCommit(root, wanted);
  if (commit !== undefined) return { ok: true, commit };
  return { ok: false, reason: named === undefined ? 'the repository has no commit yet' : `there is no commit "${wanted}"` };
}
