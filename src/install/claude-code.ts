import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { startLine, type Launcher } from './hook-script.ts';
import { isCommitted, keepOutOfGit } from './local-file.ts';

/**
 * The Claude Code side of the installation: one entry in the project's local settings file,
 * which tells Claude Code to call this tool before it runs a shell command.
 *
 * The local settings file is the one Claude Code keeps for a single machine. It is the right
 * place because the entry holds the path of the tool on this machine, like the git hook does.
 *
 * Checked against the Claude Code settings and hooks reference on 2026-11-27, with Claude Code 2.1.332.
 */

/** The settings file, relative to the top of the repository. */
export const SETTINGS_FILE = '.claude/settings.local.json';

/** The tools of Claude Code that run a shell command. */
const MATCHER = 'Bash|PowerShell';
const HOOK_WORDS = 'hook claude-code';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The command line Claude Code runs for the hook, or undefined when the path of the tool holds
 * a character that would break out of the quotes around it.
 */
export function hookCommandLine(launcher: Launcher): string | undefined {
  const start = startLine(launcher);
  return start === undefined ? undefined : `${start} ${HOOK_WORDS}`;
}

/** True for a hook entry that this tool wrote. */
function isOurs(handler: unknown): boolean {
  return isObject(handler) && typeof handler['command'] === 'string' && handler['command'].trimEnd().endsWith(` ${HOOK_WORDS}`);
}

/** The entry file a hook entry of this tool calls. */
function cliOf(handler: Json): string | undefined {
  return /^node "(.*)" hook claude-code\s*$/.exec(String(handler['command']))?.[1];
}

type Settings = { readonly ok: true; readonly settings: Json } | { readonly ok: false; readonly reason: string };

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

/** Every hook entry of this tool in the settings. */
function ourHandlers(settings: Json): Json[] {
  const hooks = settings['hooks'];
  const groups = isObject(hooks) && Array.isArray(hooks['PreToolUse']) ? (hooks['PreToolUse'] as unknown[]) : [];
  return groups.flatMap((group) => (isObject(group) && Array.isArray(group['hooks']) ? (group['hooks'] as unknown[]) : [])).filter(isOurs) as Json[];
}

/** The settings with every entry of this tool taken out, and everything else as it was. */
function withoutOurs(settings: Json): Json {
  const hooks = settings['hooks'];
  if (!isObject(hooks) || !Array.isArray(hooks['PreToolUse'])) return settings;

  const groups = (hooks['PreToolUse'] as unknown[]).flatMap((group): unknown[] => {
    if (!isObject(group) || !Array.isArray(group['hooks'])) return [group];
    const kept = (group['hooks'] as unknown[]).filter((handler) => !isOurs(handler));
    if (kept.length === group['hooks'].length) return [group];
    // A group that only held our entry goes with it.
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });

  const nextHooks: Json = { ...hooks };
  if (groups.length > 0) nextHooks['PreToolUse'] = groups;
  else delete nextHooks['PreToolUse'];

  const next: Json = { ...settings };
  if (Object.keys(nextHooks).length > 0) next['hooks'] = nextHooks;
  else delete next['hooks'];
  return next;
}

function withOurs(settings: Json, commandLine: string): Json {
  const cleaned = withoutOurs(settings);
  const hooks = isObject(cleaned['hooks']) ? cleaned['hooks'] : {};
  const groups = Array.isArray(hooks['PreToolUse']) ? (hooks['PreToolUse'] as unknown[]) : [];
  const ours = { matcher: MATCHER, hooks: [{ type: 'command', command: commandLine, timeout: 10 }] };
  return { ...cleaned, hooks: { ...hooks, PreToolUse: [...groups, ours] } };
}

export type AgentState =
  | { readonly kind: 'none' }
  | { readonly kind: 'installed'; readonly cli: string | undefined }
  | { readonly kind: 'unreadable'; readonly reason: string };

export function readAgentState(root: string): AgentState {
  const read = readSettings(join(root, SETTINGS_FILE));
  if (!read.ok) return { kind: 'unreadable', reason: read.reason };
  const [first] = ourHandlers(read.settings);
  return first === undefined ? { kind: 'none' } : { kind: 'installed', cli: cliOf(first) };
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

  const had = ourHandlers(read.settings).length > 0;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(withOurs(read.settings, commandLine), null, 2)}\n`);
  return { outcome: had ? 'updated' : 'written', newlyExcluded: keepOutOfGit(root, SETTINGS_FILE) };
}

export type AgentUninstall = 'removed' | 'not-installed' | 'unreadable';

/** Takes the hook entry out again. A settings file that is empty afterwards is removed. */
export function uninstallAgentHook(root: string): AgentUninstall {
  const path = join(root, SETTINGS_FILE);
  const read = readSettings(path);
  if (!read.ok) return 'unreadable';
  if (ourHandlers(read.settings).length === 0) return 'not-installed';

  const next = withoutOurs(read.settings);
  if (Object.keys(next).length === 0) rmSync(path);
  else writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return 'removed';
}
