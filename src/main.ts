import { approveCommand } from './approval/command.ts';
import { auditCommand } from './audit/command.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';
import { gateCommand } from './gate/command.ts';
import { hookCommand } from './hook/command.ts';
import { doctorCommand, installCommand, uninstallCommand } from './install/command.ts';
import { mergeCommand } from './merge/command.ts';
import { policyCommand } from './policy/command.ts';
import { fetchCommand, sendCommand } from './travel/command.ts';
import { readVersion } from './version.ts';
import { verifyCommand } from './verify/command.ts';
import { wordsCommand } from './words/command.ts';

/** Where a command writes. Tests pass their own, so nothing is printed for real. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

interface Command {
  readonly name: string;
  /** One line for the list of commands in the help text. */
  readonly summary: string;
  readonly run: (args: readonly string[], io: Io) => Promise<ExitCode>;
}

/**
 * Every command of the tool, in the order the help text lists them.
 * The help text and the choice of what to run are both made from this one list, so a command
 * cannot be in one and missing from the other.
 */
const COMMANDS: readonly Command[] = [
  { name: 'approve', summary: 'Sign an approval of one commit into one branch. For a person, not an agent', run: approveCommand },
  { name: 'audit', summary: 'Look back at what entered a branch, and say whether each entry had its record', run: auditCommand },
  { name: 'doctor', summary: 'Report what is enforced in this clone, and what is not', run: doctorCommand },
  { name: 'fetch', summary: 'Get the records and approvals the remote holds for a commit', run: fetchCommand },
  { name: 'gate', summary: 'Run the checks of a gate level on the current commit', run: gateCommand },
  { name: 'hook', summary: 'The entry points git and the coding agent call. Not run by hand', run: hookCommand },
  { name: 'install', summary: 'Put the hooks of this tool into this clone', run: installCommand },
  { name: 'merge', summary: 'Merge a pull request on GitHub, only when its commit has its record', run: mergeCommand },
  { name: 'policy', summary: 'Check gotreceipts.json and show what the gate will do', run: policyCommand },
  { name: 'send', summary: 'Send the records and approvals of a commit to the remote', run: sendCommand },
  { name: 'uninstall', summary: 'Remove the hooks again', run: uninstallCommand },
  { name: 'verify', summary: 'Say whether a commit has a record that satisfies a gate level', run: verifyCommand },
  { name: 'words', summary: 'Fail if a file, a file path or a commit message contains a private word', run: wordsCommand },
];

/** One line of a list in the help text: the name, then its explanation, lined up with the others. */
function listed(name: string, explanation: string): string {
  return `  ${name.padEnd(17)}${explanation}`;
}

export const USAGE = [
  'Usage: gotreceipts <command> [options]',
  '',
  'Commands:',
  ...COMMANDS.map((command) => listed(command.name, command.summary)),
  '',
  'Options:',
  listed('-h, --help', 'Show this help'),
  listed('-v, --version', 'Show the version'),
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
  const [name, ...rest] = argv;

  if (name === undefined) {
    io.err('gotreceipts: no command given.');
    io.err(USAGE);
    return EXIT.CANNOT_RUN;
  }
  if (name === '--help' || name === '-h') {
    io.out(USAGE);
    return EXIT.PASS;
  }
  if (name === '--version' || name === '-v') {
    io.out(readVersion());
    return EXIT.PASS;
  }

  const command = COMMANDS.find((each) => each.name === name);
  if (command === undefined) {
    io.err(`gotreceipts: unknown command "${name}".`);
    io.err(USAGE);
    return EXIT.CANNOT_RUN;
  }
  return command.run(rest, io);
}
