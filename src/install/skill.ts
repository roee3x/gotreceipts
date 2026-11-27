import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startLine, type Launcher } from './hook-script.ts';
import { isCommitted, keepOutOfGit } from './local-file.ts';

/**
 * The skill: a short text that tells the coding agent how to work behind the gate. It ships
 * with the tool, in the folder "skills", and "gotreceipts install" puts a copy where Claude
 * Code looks for the skills of a project.
 *
 * The skill enforces nothing. The hooks and the merge command do that. The skill is there so
 * the agent knows what to run, and how to read a refusal, before it runs into one.
 *
 * Checked against the Claude Code skills reference on 2026-11-27, with Claude Code 2.1.332:
 * a project skill is the file .claude/skills/<name>/SKILL.md, with a name and a description
 * between two "---" lines at its top.
 */

/** The installed skill, relative to the top of the repository. */
export const SKILL_FILE = '.claude/skills/gotreceipts/SKILL.md';

/** The words that mark an installed skill as written by this tool. A file without them is someone else's. */
export const SKILL_MARKER = 'gotreceipts:managed-skill';

/** The skill as it ships with this tool, or undefined when the file is not where it belongs. */
export function shippedSkill(): string | undefined {
  try {
    const path = fileURLToPath(new URL('../../skills/gotreceipts/SKILL.md', import.meta.url));
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

/**
 * The text "install" writes: the shipped skill, then how the tool is started on this machine,
 * then the marker. The start line is why the copy must not be committed.
 */
export function skillText(shipped: string, launcher: Launcher): string {
  const start = startLine(launcher);
  return [
    shipped.trimEnd(),
    '',
    '## On this machine',
    '',
    start === undefined
      ? 'If `gotreceipts` is not found as a command, ask the user how the tool is started here.'
      : `If \`gotreceipts\` is not found as a command, start it as: \`${start}\``,
    '',
    `<!-- ${SKILL_MARKER}. Written by "gotreceipts install". Run it again to update this file. Edits made here are overwritten. -->`,
    '',
  ].join('\n');
}

function readInstalled(root: string): string | undefined {
  const path = join(root, SKILL_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : undefined;
}

export type SkillState =
  | 'none'
  /** Written by this tool, and it is the text this version of the tool writes. */
  | 'current'
  /** Written by this tool, by another version of it or from another place. */
  | 'outdated'
  /** A skill of the same name that someone else wrote. */
  | 'foreign'
  /** The skill that ships with the tool could not be read. */
  | 'no-source';

export function readSkillState(root: string, launcher: Launcher): SkillState {
  const installed = readInstalled(root);
  if (installed === undefined) return 'none';
  if (!installed.includes(SKILL_MARKER)) return 'foreign';
  const shipped = shippedSkill();
  if (shipped === undefined) return 'no-source';
  return installed === skillText(shipped, launcher) ? 'current' : 'outdated';
}

export type SkillInstall =
  | { readonly outcome: 'written' | 'updated'; readonly newlyExcluded: boolean }
  | { readonly outcome: 'foreign' }
  /** The skill file is committed. A path of this machine does not belong in it. */
  | { readonly outcome: 'tracked' }
  | { readonly outcome: 'no-source' };

/** Writes the skill into the project. A skill of the same name that someone else wrote is left alone. */
export function installSkill(root: string, launcher: Launcher): SkillInstall {
  const shipped = shippedSkill();
  if (shipped === undefined) return { outcome: 'no-source' };

  const installed = readInstalled(root);
  if (installed !== undefined && !installed.includes(SKILL_MARKER)) return { outcome: 'foreign' };
  if (isCommitted(root, SKILL_FILE)) return { outcome: 'tracked' };

  const path = join(root, SKILL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, skillText(shipped, launcher));
  return { outcome: installed === undefined ? 'written' : 'updated', newlyExcluded: keepOutOfGit(root, SKILL_FILE) };
}

export type SkillUninstall = 'removed' | 'not-installed' | 'not-ours';

/** Removes the skill again, and the folders it was in when nothing else is in them. */
export function uninstallSkill(root: string): SkillUninstall {
  const installed = readInstalled(root);
  if (installed === undefined) return 'not-installed';
  if (!installed.includes(SKILL_MARKER)) return 'not-ours';

  const path = join(root, SKILL_FILE);
  rmSync(path);
  for (const folder of [dirname(path), dirname(dirname(path))]) {
    try {
      // Removes a folder only when it is empty. Other skills stay where they are.
      rmdirSync(folder);
    } catch {
      break;
    }
  }
  return 'removed';
}
