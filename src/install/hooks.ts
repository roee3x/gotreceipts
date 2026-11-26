import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { git } from '../git.ts';
import { cliOfHook, hookScript, isManagedHook, keptName, type Launcher } from './hook-script.ts';

/** The git hooks this tool installs. */
export const HOOK_NAMES = ['pre-push'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Where this tool is right now: the program running it, and the entry file next to this module. */
export function currentLauncher(): Launcher {
  const entry = import.meta.url.endsWith('.ts') ? '../cli.ts' : '../cli.js';
  return { node: process.execPath, cli: fileURLToPath(new URL(entry, import.meta.url)) };
}

export type HooksFolder =
  | { readonly kind: 'standard'; readonly folder: string }
  /** Git was told to look for hooks somewhere else, usually a folder that is committed. */
  | { readonly kind: 'custom'; readonly setting: string }
  | { readonly kind: 'unknown' };

/** Finds the folder git reads hooks from in this repository. */
export function findHooksFolder(root: string): HooksFolder {
  const custom = git(['config', '--get', 'core.hooksPath'], root);
  if (custom.ok && custom.stdout.trim() !== '') {
    return { kind: 'custom', setting: custom.stdout.trim() };
  }
  const path = git(['rev-parse', '--git-path', 'hooks'], root);
  if (!path.ok || path.stdout.trim() === '') return { kind: 'unknown' };
  return { kind: 'standard', folder: resolve(root, path.stdout.trim()) };
}

export type HookState =
  | { readonly kind: 'none' }
  /** Written by this tool. `cli` is the entry file it calls. */
  | { readonly kind: 'managed'; readonly cli: string | undefined; readonly keptOlder: boolean }
  /** A hook someone else wrote. */
  | { readonly kind: 'foreign'; readonly keptOlder: boolean };

export function readHookState(folder: string, name: HookName): HookState {
  const path = join(folder, name);
  const keptOlder = existsSync(join(folder, keptName(name)));
  if (!existsSync(path)) return { kind: 'none' };
  const text = readFileSync(path, 'utf8');
  if (isManagedHook(text)) return { kind: 'managed', cli: cliOfHook(text), keptOlder };
  return { kind: 'foreign', keptOlder };
}

export type InstallOutcome = 'written' | 'updated' | 'written-after-keeping-older' | 'blocked-by-two-older-hooks';

/**
 * Puts the managed hook in place.
 *
 * A hook that someone else wrote is never overwritten. It is renamed, and the managed hook
 * runs it first. If a renamed hook already exists as well, nothing is changed.
 */
export function installHook(folder: string, name: HookName, launcher: Launcher): InstallOutcome {
  const path = join(folder, name);
  const state = readHookState(folder, name);

  let outcome: InstallOutcome;
  if (state.kind === 'foreign') {
    if (state.keptOlder) return 'blocked-by-two-older-hooks';
    renameSync(path, join(folder, keptName(name)));
    outcome = 'written-after-keeping-older';
  } else {
    outcome = state.kind === 'managed' ? 'updated' : 'written';
  }

  writeFileSync(path, hookScript(name, launcher));
  chmodSync(path, 0o755);
  return outcome;
}

export type UninstallOutcome = 'removed' | 'removed-and-restored-older' | 'not-installed' | 'not-ours';

/** Takes the managed hook out again, and puts an older hook back where it was. */
export function uninstallHook(folder: string, name: HookName): UninstallOutcome {
  const path = join(folder, name);
  const state = readHookState(folder, name);
  if (state.kind === 'none') return 'not-installed';
  if (state.kind === 'foreign') return 'not-ours';

  rmSync(path);
  if (state.keptOlder) {
    renameSync(join(folder, keptName(name)), path);
    return 'removed-and-restored-older';
  }
  return 'removed';
}
