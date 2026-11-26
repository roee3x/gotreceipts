import { forbiddenCommand, guardMessage } from '../agent/guard.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { startLine } from '../install/hook-script.ts';
import { currentLauncher } from '../install/hooks.ts';
import type { Io } from '../main.ts';

/**
 * The hook Claude Code calls before it runs a shell command (its "PreToolUse" event).
 *
 * Claude Code gives it a JSON description of the call. When the command is one that goes around
 * the gate, the hook answers with a JSON "deny" and the reason, which Claude Code shows to the
 * agent. For every other command it prints nothing, and the call goes on as it would have.
 *
 * Checked against the Claude Code hooks reference on 2026-11-27, with Claude Code 2.1.332:
 * the input holds "tool_input.command" for both the Bash and the PowerShell tool, and a
 * decision is returned as "hookSpecificOutput.permissionDecision".
 *
 * This hook fails open, on purpose, and unlike the git hook. When it cannot read its input it
 * lets the call through. It sees every shell command the agent runs, so blocking on "could not
 * read" would stop the agent from doing anything at all, and the hook would be removed. It is
 * the early "no". The git hook and the merge command are the checkpoints, and they fail closed.
 */
export function claudeCodeHook(input: string, io: Io): ExitCode {
  let command: unknown;
  try {
    const parsed: unknown = JSON.parse(input);
    const toolInput = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['tool_input'] : undefined;
    command = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>)['command'] : undefined;
  } catch {
    command = undefined;
  }

  if (typeof command !== 'string') {
    io.err('gotreceipts claude-code hook: the input holds no shell command, so nothing was checked.');
    return EXIT.PASS;
  }

  const rule = forbiddenCommand(command);
  if (rule === undefined) return EXIT.PASS;

  const launcher = startLine(currentLauncher()) ?? 'the command the user gives you';
  io.out(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: guardMessage(rule, launcher),
      },
    }),
  );
  return EXIT.PASS;
}
