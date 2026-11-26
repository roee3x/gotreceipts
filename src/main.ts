import { EXIT, type ExitCode } from './exit-codes.ts';
import { readVersion } from './version.ts';

/** Where a command writes. Tests pass their own, so nothing is printed for real. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = [
  'Usage: gotreceipts <command>',
  '',
  'Options:',
  '  -h, --help       Show this help',
  '  -v, --version    Show the version',
  '',
  'Exit codes: 0 = pass, 1 = refused, 2 = could not run.',
].join('\n');

/**
 * Runs one command and returns its exit code.
 *
 * A missing or unknown command is "could not run", not a pass.
 * A hook that calls the tool the wrong way must fail, never slip through.
 */
export async function main(argv: readonly string[], io: Io): Promise<ExitCode> {
  const command = argv[0];

  if (command === undefined) {
    io.err('gotreceipts: no command given.');
    io.err(USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (command === '--help' || command === '-h') {
    io.out(USAGE);
    return EXIT.PASS;
  }

  if (command === '--version' || command === '-v') {
    io.out(readVersion());
    return EXIT.PASS;
  }

  io.err(`gotreceipts: unknown command "${command}".`);
  io.err(USAGE);
  return EXIT.CANNOT_RUN;
}
