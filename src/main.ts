import { EXIT, type ExitCode } from './exit-codes.ts';
import { gateCommand } from './gate/command.ts';
import { policyCommand } from './policy/command.ts';
import { readVersion } from './version.ts';
import { wordsCommand } from './words/command.ts';

/** Where a command writes. Tests pass their own, so nothing is printed for real. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = [
  'Usage: gotreceipts <command> [options]',
  '',
  'Commands:',
  '  gate             Run the checks of a gate level on the current commit',
  '  policy           Check gotreceipts.json and show what the gate will do',
  '  words            Fail if a file, a file path or a commit message contains a private word',
  '',
  'Options:',
  '  -h, --help       Show this help',
  '  -v, --version    Show the version',
  '',
  'Run "gotreceipts <command> --help" for the options of one command.',
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
  const rest = argv.slice(1);

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

  if (command === 'words') {
    return wordsCommand(rest, io);
  }

  if (command === 'policy') {
    return policyCommand(rest, io);
  }

  if (command === 'gate') {
    return gateCommand(rest, io);
  }

  io.err(`gotreceipts: unknown command "${command}".`);
  io.err(USAGE);
  return EXIT.CANNOT_RUN;
}
