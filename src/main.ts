import { EXIT, type ExitCode } from './exit-codes.ts';
import { gateCommand } from './gate/command.ts';
import { hookCommand } from './hook/command.ts';
import { doctorCommand, installCommand, uninstallCommand } from './install/command.ts';
import { mergeCommand } from './merge/command.ts';
import { policyCommand } from './policy/command.ts';
import { readVersion } from './version.ts';
import { verifyCommand } from './verify/command.ts';
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
  '  doctor           Report what is enforced in this clone, and what is not',
  '  gate             Run the checks of a gate level on the current commit',
  '  hook             The entry points git and the coding agent call. Not run by hand',
  '  install          Put the hooks of this tool into this clone',
  '  merge            Merge a pull request on GitHub, only when its commit has its record',
  '  policy           Check gotreceipts.json and show what the gate will do',
  '  uninstall        Remove the hooks again',
  '  verify           Say whether a commit has a record that satisfies a gate level',
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

  if (command === 'verify') {
    return verifyCommand(rest, io);
  }

  if (command === 'hook') {
    return hookCommand(rest, io);
  }

  if (command === 'install') {
    return installCommand(rest, io);
  }

  if (command === 'uninstall') {
    return uninstallCommand(rest, io);
  }

  if (command === 'doctor') {
    return doctorCommand(rest, io);
  }

  if (command === 'merge') {
    return mergeCommand(rest, io);
  }

  io.err(`gotreceipts: unknown command "${command}".`);
  io.err(USAGE);
  return EXIT.CANNOT_RUN;
}
