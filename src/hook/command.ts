import { EXIT, type ExitCode } from '../exit-codes.ts';
import type { Io } from '../main.ts';
import { claudeCodeHook } from './claude-code.ts';
import { prePush } from './pre-push.ts';

export const HOOK_USAGE = [
  'Usage: gotreceipts hook <name>',
  '',
  'The entry points that git and the coding agent call. They are not meant to be run by hand.',
  '',
  'Hooks:',
  '  pre-push      Called by git before a push. Refuses the push when a commit that would enter',
  '                a branch with a gate level has no valid record at that level.',
  '  claude-code   Called by Claude Code before it runs a shell command or edits a file. Stops',
  '                the few commands that go around the gate, such as a bare "gh pr merge", and',
  '                names the command to use instead. Before an edit of a protected file, it',
  '                has Claude Code ask the user.',
  '',
  'The git hook blocks when it cannot check: "could not run" is never a pass.',
  'The agent hook is early feedback and lets a call through when it cannot read it.',
  '',
  'Exit codes of pre-push: 0 = allowed, 1 = refused, 2 = the hook could not check.',
].join('\n');

/** Everything that was piped to this process. Nothing, when it was started by hand at a keyboard. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function hookCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const name = args[0];

  if (name === '--help' || name === '-h') {
    io.out(HOOK_USAGE);
    return EXIT.PASS;
  }

  if (name === 'pre-push') {
    // Git also passes the name and the address of the remote. The decision does not depend on them.
    return prePush(await readStdin(), io, Date.now());
  }

  if (name === 'claude-code') {
    return claudeCodeHook(await readStdin(), io);
  }

  io.err(name === undefined ? 'gotreceipts hook: no hook named.' : `gotreceipts hook: unknown hook "${name}".`);
  io.err(HOOK_USAGE);
  return EXIT.CANNOT_RUN;
}
