import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { isObject, type JsonObject as Json } from '../json.ts';
import { startLine, type Launcher } from './hook-script.ts';
import { isCommitted, keepOutOfGit } from './local-file.ts';

/**
 * The Claude Code side of the installation: one entry in the project's local settings file,
 * which tells Claude Code to call this tool before it runs a shell command or changes a file.
 *
 * The local settings file is the one Claude Code keeps for a single machine. It is the right
 * place because the entry holds the path of the tool on this machine, like the git hook does.
 *
 * The part of the file this code reads and writes looks like this:
 *
 *   { "hooks": { "PreToolUse": [
 *       { "matcher": "Bash|Edit", "hooks": [ { "type": "command", "command": "..." } ] }
 *   ] } }
 *
 * "PreToolUse" is a list of groups. A group names the tools it is for, and holds the entries
 * that are called for those tools. Everything else in the file belongs to the user and stays
 * exactly as it is.
 *
 * Checked against the Claude Code settings and hooks reference on 2026-11-27, with Claude Code 2.1.332.
 */

/** The settings file, relative to the top of the repository. */
export const SETTINGS_FILE = '.claude/settings.local.json';

/**
 * The tools of Claude Code the hook is called for: the two that run a shell command, and the
 * ones that change a file. "MultiEdit" is a name older versions of Claude Code used.
 */
export const MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit';

/** What the command of an entry of this tool ends with. It is how such an entry is told from the others. */
const HOOK_WORDS = 'hook claude-code';

/**
 * The command line Claude Code runs for the hook, or undefined when the path of the tool holds
 * a character that would break out of the quotes around it.
 */
export function hookCommandLine(launcher: Launcher): string | undefined {
  const start = startLine(launcher);
  return start === undefined ? undefined : `${start} ${HOOK_WORDS}`;
}

// --- the file ---

type Settings = { readonly ok: true; readonly settings: Json } | { readonly ok: false; readonly reason: string };

/** Reads the settings. A file that is not there is an empty one. A file this code cannot follow is not touched. */
function readSettings(path: string): Settings {
  if (!existsSync(path)) return { ok: true, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'it is not valid JSON' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'it does not hold a JSON object' };
  const hooks = parsed['hooks'];
  if (hooks !== undefined && !isObject(hooks)) return { ok: false, reason: 'its "hooks" entry is not an object' };
  const before = isObject(hooks) ? hooks['PreToolUse'] : undefined;
  if (before !== undefined && !Array.isArray(before)) return { ok: false, reason: 'its "hooks.PreToolUse" entry is not a list' };
  return { ok: true, settings: parsed };
}

function writeSettings(path: string, settings: Json): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

// --- the entries of this tool, among everything else in the file ---

/** True for a hook entry that this tool wrote. */
function isOurs(entry: unknown): entry is Json {
  return isObject(entry) && typeof entry['command'] === 'string' && entry['command'].trimEnd().endsWith(` ${HOOK_WORDS}`);
}

/** The entry file an entry of this tool calls. */
function cliOf(entry: Json): string | undefined {
  return new RegExp(`^node "(.*)" ${HOOK_WORDS}\\s*$`).exec(String(entry['command']))?.[1];
}

/** One group of "PreToolUse", with the entries of this tool told apart from the rest. */
interface Group {
  /** The group as the file holds it. It may be anything: what this code cannot read, it keeps. */
  readonly written: unknown;
  /** The tools the group is for, as written. */
  readonly matcher: unknown;
  readonly ours: readonly Json[];
  readonly others: readonly unknown[];
}

/** The one walk over the groups. Reading the state, adding the entry and taking it out all start here. */
function groupsOf(settings: Json): Group[] {
  const hooks = settings['hooks'];
  const groups: unknown[] = isObject(hooks) && Array.isArray(hooks['PreToolUse']) ? hooks['PreToolUse'] : [];
  return groups.map((written) => {
    const entries: unknown[] = isObject(written) && Array.isArray(written['hooks']) ? written['hooks'] : [];
    return {
      written,
      matcher: isObject(written) ? written['matcher'] : undefined,
      ours: entries.filter(isOurs),
      others: entries.filter((entry) => !isOurs(entry)),
    };
  });
}

function hasOurs(settings: Json): boolean {
  return groupsOf(settings).some((group) => group.ours.length > 0);
}

/** The settings with every entry of this tool taken out, and everything else as it was. */
function withoutOurs(settings: Json): Json {
  const hooks = settings['hooks'];
  if (!isObject(hooks) || !Array.isArray(hooks['PreToolUse'])) return settings;

  const groups = groupsOf(settings).flatMap(({ written, ours, others }): unknown[] => {
    if (ours.length === 0 || !isObject(written)) return [written];
    // A group that only held our entry goes with it.
    return others.length === 0 ? [] : [{ ...written, hooks: others }];
  });

  // A list that is empty afterwards goes too, and so does a "hooks" entry that is empty afterwards.
  const nextHooks: Json = { ...hooks };
  if (groups.length > 0) nextHooks['PreToolUse'] = groups;
  else delete nextHooks['PreToolUse'];

  const next: Json = { ...settings };
  if (Object.keys(nextHooks).length > 0) next['hooks'] = nextHooks;
  else delete next['hooks'];
  return next;
}

/** The settings with one entry of this tool, in a group of its own at the end of the list. An older entry is replaced. */
function withOurs(settings: Json, commandLine: string): Json {
  const cleaned = withoutOurs(settings);
  const hooks = isObject(cleaned['hooks']) ? cleaned['hooks'] : {};
  const groups: unknown[] = Array.isArray(hooks['PreToolUse']) ? hooks['PreToolUse'] : [];
  const ours = { matcher: MATCHER, hooks: [{ type: 'command', command: commandLine, timeout: 10 }] };
  return { ...cleaned, hooks: { ...hooks, PreToolUse: [...groups, ours] } };
}

// --- what the rest of the tool asks ---

export type AgentState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'installed';
      readonly cli: string | undefined;
      /** False when the entry was written by a version of the tool that covered fewer tools. */
      readonly current: boolean;
    }
  | { readonly kind: 'unreadable'; readonly reason: string };

export function readAgentState(root: string): AgentState {
  const read = readSettings(join(root, SETTINGS_FILE));
  if (!read.ok) return { kind: 'unreadable', reason: read.reason };

  const withOurEntry = groupsOf(read.settings).filter((group) => group.ours.length > 0);
  const first = withOurEntry[0]?.ours[0];
  if (first === undefined) return { kind: 'none' };
  // This version writes one group, for the tools of MATCHER. Anything else was written by another version.
  const current = withOurEntry.length === 1 && withOurEntry[0]?.matcher === MATCHER;
  return { kind: 'installed', cli: cliOf(first), current };
}

export type AgentInstall =
  | { readonly outcome: 'written' | 'updated'; readonly newlyExcluded: boolean }
  | { readonly outcome: 'unreadable'; readonly reason: string }
  /** The settings file is committed. A path of this machine does not belong in it. */
  | { readonly outcome: 'tracked' }
  | { readonly outcome: 'unsafe-path' };

/** Writes the hook entry into the local settings file. Everything else in the file stays as it is. */
export function installAgentHook(root: string, launcher: Launcher): AgentInstall {
  const commandLine = hookCommandLine(launcher);
  if (commandLine === undefined) return { outcome: 'unsafe-path' };
  if (isCommitted(root, SETTINGS_FILE)) return { outcome: 'tracked' };

  const path = join(root, SETTINGS_FILE);
  const read = readSettings(path);
  if (!read.ok) return { outcome: 'unreadable', reason: read.reason };

  const had = hasOurs(read.settings);
  mkdirSync(dirname(path), { recursive: true });
  writeSettings(path, withOurs(read.settings, commandLine));
  return { outcome: had ? 'updated' : 'written', newlyExcluded: keepOutOfGit(root, SETTINGS_FILE) };
}

export type AgentUninstall = 'removed' | 'not-installed' | 'unreadable';

/** Takes the hook entry out again. A settings file that is empty afterwards is removed. */
export function uninstallAgentHook(root: string): AgentUninstall {
  const path = join(root, SETTINGS_FILE);
  const read = readSettings(path);
  if (!read.ok) return 'unreadable';
  if (!hasOurs(read.settings)) return 'not-installed';

  const next = withoutOurs(read.settings);
  if (Object.keys(next).length === 0) rmSync(path);
  else writeSettings(path, next);
  return 'removed';
}
