import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { forbiddenCommand, guardMessage } from '../agent/guard.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { headCommit, repoRoot } from '../git.ts';
import { startLine } from '../install/hook-script.ts';
import { currentLauncher } from '../install/hooks.ts';
import type { Io } from '../main.ts';
import { policyInCommit } from '../policy/committed.ts';
import { isProtectedPath } from '../policy/policy.ts';

/**
 * The hook Claude Code calls before it uses a tool (its "PreToolUse" event).
 *
 * Claude Code gives it a JSON description of the call. The hook does two things:
 *
 *   A shell command that goes around the gate is denied, with the reason. Claude Code shows the
 *   reason to the agent.
 *
 *   An edit of a protected file is sent to the user: Claude Code asks them before the edit is
 *   made, and shows them the reason. A protected file is part of the gate itself, so the
 *   person decides, not the agent.
 *
 * For every other call it prints nothing, and the call goes on as it would have.
 *
 * Checked against the Claude Code hooks reference on 2026-11-27, with Claude Code 2.1.332:
 * the input holds "cwd" and "tool_input"; "tool_input.command" for the Bash and the PowerShell
 * tool, "tool_input.file_path" for the Write and the Edit tool; and a decision is returned as
 * "hookSpecificOutput.permissionDecision", which may be "deny" or "ask". With "ask", the
 * reason is shown to the user. In a run with no one to ask, Claude Code denies the call.
 *
 * This hook fails open, on purpose, and unlike the git hook. When it cannot read its input it
 * lets the call through. It sees every tool call the agent makes, so blocking on "could not
 * read" would stop the agent from doing anything at all, and the hook would be removed. It is
 * the early "no". The git hook and the merge command are the checkpoints, and they fail closed.
 *
 * It also sees only the edit tools. A protected file that is changed by a shell command is not
 * noticed here. It is noticed at the door, where the commit is compared with its target branch.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function answer(io: Io, decision: 'deny' | 'ask', reason: string): ExitCode {
  io.out(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
    }),
  );
  return EXIT.PASS;
}

/**
 * The one true spelling of a path. One file can be reached under several names: through a
 * link, or on Windows through a short name such as "PROGRA~1". Two names of the same file must
 * compare as equal, or a protected file could be edited under its other name.
 *
 * The file itself may not exist yet, so the nearest folder that does exist is looked up, and
 * the rest of the path is put back behind it.
 */
function trueSpelling(path: string): string {
  const rest: string[] = [];
  let existing = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * The path of a file as the policy names it: counted from the top of the repository, with
 * forward slashes. Undefined for a file outside the repository.
 */
export function pathInRepository(root: string, cwd: string, file: string): string | undefined {
  const full = trueSpelling(isAbsolute(file) ? file : resolve(cwd, file));
  const inside = relative(trueSpelling(root), full);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return inside.replace(/\\/g, '/');
}

/** The text the user reads when Claude Code asks them about an edit of a protected file. */
export function protectedFileMessage(path: string): string {
  return [
    `GotReceipts: "${path}" is a protected file. It is part of this repository's merge gate.`,
    'A change to it changes what every later commit has to pass, and it needs the approval of the owner before it can be merged.',
    'Allow this edit only if you want the gate itself changed.',
  ].join(' ');
}

/** The nearest folder at or above `path` that exists. A file that is about to be written may sit in a folder that is not there yet. */
function nearestFolder(path: string): string {
  let folder = resolve(path);
  while (!existsSync(folder) || !statSync(folder).isDirectory()) {
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return folder;
}

/** The edit of a file: asks the user when the file is protected, and lets every other edit through. */
function checkEdit(file: string, cwd: string, io: Io): ExitCode {
  // The repository is the one the file is in. The session may have been started in a folder above it.
  const root = repoRoot(nearestFolder(dirname(isAbsolute(file) ? file : resolve(cwd, file))));
  if (root === undefined) return EXIT.PASS;
  const path = pathInRepository(root, cwd, file);
  if (path === undefined) return EXIT.PASS;

  // The list of protected files is the committed one. The file in the folder may be the very
  // thing that is being edited. A repository with no committed policy does not use the gate
  // yet, so it has nothing to protect: its first policy is written without a question.
  const head = headCommit(root);
  const committed = head === undefined ? undefined : policyInCommit(root, head);
  if (committed?.kind !== 'policy') return EXIT.PASS;
  if (!isProtectedPath(committed.policy, path)) return EXIT.PASS;

  return answer(io, 'ask', protectedFileMessage(path));
}

export function claudeCodeHook(input: string, io: Io): ExitCode {
  let toolInput: Json = {};
  let cwd = process.cwd();
  try {
    const parsed: unknown = JSON.parse(input);
    if (isObject(parsed)) {
      if (isObject(parsed['tool_input'])) toolInput = parsed['tool_input'];
      if (typeof parsed['cwd'] === 'string' && parsed['cwd'] !== '') cwd = parsed['cwd'];
    }
  } catch {
    // Handled below: an input that cannot be read holds nothing to check.
  }

  const command = toolInput['command'];
  if (typeof command === 'string') {
    const rule = forbiddenCommand(command);
    if (rule === undefined) return EXIT.PASS;
    const launcher = startLine(currentLauncher()) ?? 'the command the user gives you';
    return answer(io, 'deny', guardMessage(rule, launcher));
  }

  // The edit tools name the file as "file_path". The notebook tool names it "notebook_path".
  const file = toolInput['file_path'] ?? toolInput['notebook_path'];
  if (typeof file === 'string' && file !== '') return checkEdit(file, cwd, io);

  io.err('gotreceipts claude-code hook: the input holds no shell command and no file, so nothing was checked.');
  return EXIT.PASS;
}
