import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { repoRoot } from '../git.ts';
import type { Io } from '../main.ts';
import { loadPolicy } from '../policy/load.ts';
import type { Policy } from '../policy/policy.ts';
import { installAgentHook, SETTINGS_FILE, uninstallAgentHook } from './claude-code.ts';
import { inspect, printReport, SHARED_HOOK_LINE } from './doctor.ts';
import { keptName, looksTemporary, type Launcher } from './hook-script.ts';
import { currentLauncher, findHooksFolder, installHook, uninstallHook } from './hooks.ts';
import { installSkill, SKILL_FILE, uninstallSkill } from './skill.ts';

export const INSTALL_USAGE = [
  'Usage: gotreceipts install',
  '',
  'Puts the two hooks of this tool and its skill into this clone of the repository, and',
  'reports what is enforced from then on and what is not.',
  '',
  '  git pre-push hook   Before every push, each commit that would enter a branch with a gate',
  '                      level must have a valid record at that level.',
  '  Claude Code hook    Before the agent runs a shell command: a bare "gh pr merge" and',
  '                      "git push --no-verify" are stopped, and the agent is told what to run.',
  '                      "gotreceipts approve" is stopped too: an approval is for a person.',
  '                      Before the agent edits a protected file, such as the policy file:',
  '                      Claude Code asks the user first.',
  '  Claude Code skill   A short text that tells the agent how to work with the gate: when to',
  '                      run it, and how to read a refusal. It stops nothing.',
  '',
  'A git hook that is already there is never overwritten. It is kept under the name',
  'pre-push.local, and it runs first. "gotreceipts uninstall" puts it back.',
  `The Claude Code hook is one entry in ${SETTINGS_FILE}. The rest of that file is left as it is.`,
  `The skill is the file ${SKILL_FILE}.`,
  'Both files hold a path of this machine. They are kept out of git, through .git/info/exclude',
  'when no ignore rule covers them.',
  '',
  'Hooks do not come with a clone. Run this once in every clone.',
  '',
  'Exit codes: 0 = both hooks are in place, 1 = not both, 2 = the command could not run.',
].join('\n');

export const UNINSTALL_USAGE = [
  'Usage: gotreceipts uninstall',
  '',
  'Removes what "gotreceipts install" wrote: the git hook, the Claude Code hook entry and',
  'the skill. A git hook that was kept aside is put back in its place. Anything this tool',
  'did not write is never touched. Lines it added to .git/info/exclude stay: they name',
  'files that are gone, and do nothing.',
  '',
  'Exit codes: 0 = no hook of this tool is left, 1 = something could not be removed, 2 = the command could not run.',
].join('\n');

export const DOCTOR_USAGE = [
  'Usage: gotreceipts doctor',
  '',
  'Reports what is enforced in this clone of the repository, and what is not.',
  'It changes nothing.',
  '',
  'Exit codes: 0 = both hooks are in place, 1 = not both, 2 = the command could not run.',
].join('\n');

type Setup = { readonly ok: true; readonly policy: Policy; readonly root: string } | { readonly ok: false; readonly code: ExitCode };

/** Reads the options. These commands take none but --help. Returns an exit code when there is nothing more to do. */
function readOptions(command: string, usage: string, args: readonly string[], io: Io): ExitCode | undefined {
  let help: boolean | undefined;
  try {
    const parsed = parseArgs({ args: [...args], options: { help: { type: 'boolean', short: 'h' } }, strict: true });
    help = parsed.values.help;
  } catch (error) {
    io.err(`gotreceipts ${command}: ${error instanceof Error ? error.message : String(error)}`);
    io.err(usage);
    return EXIT.CANNOT_RUN;
  }
  if (help === true) {
    io.out(usage);
    return EXIT.PASS;
  }
  return undefined;
}

/** What install and doctor share: read the options, find the repository, read the policy. */
function setUp(command: string, usage: string, args: readonly string[], io: Io): Setup {
  const done = readOptions(command, usage, args, io);
  if (done !== undefined) return { ok: false, code: done };

  const loaded = loadPolicy(process.cwd());
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`gotreceipts ${command}: CANNOT RUN: ${error}`);
    return { ok: false, code: EXIT.CANNOT_RUN };
  }
  if (loaded.root === undefined) {
    io.err(`gotreceipts ${command}: CANNOT RUN: this folder is not inside a git repository`);
    return { ok: false, code: EXIT.CANNOT_RUN };
  }
  return { ok: true, policy: loaded.policy, root: loaded.root };
}

function verdict(io: Io, missing: readonly string[]): ExitCode {
  if (missing.length === 0) {
    io.out('VERDICT: PASS (the push hook and the Claude Code hook are in place)');
    return EXIT.PASS;
  }
  io.out(`VERDICT: NOT PROTECTED (not in place: ${missing.join(', ')})`);
  return EXIT.REFUSED;
}

/** Installs the git hook and returns the lines that say what happened. */
function installGitPart(root: string, launcher: Launcher): string[] {
  const place = findHooksFolder(root);
  if (place.kind === 'unknown') return ['git pre-push hook: NOT WRITTEN: git could not say where its hooks folder is'];
  if (place.kind === 'custom') {
    return [
      `git pre-push hook: NOT WRITTEN: git looks for hooks in "${place.setting}" (the setting core.hooksPath).`,
      '  Such a folder is usually committed, and a hook written here holds paths of this machine.',
      '  Add this line to the pre-push hook in that folder instead:',
      `    ${SHARED_HOOK_LINE}`,
    ];
  }
  switch (installHook(place.folder, 'pre-push', launcher)) {
    case 'written':
      return ['git pre-push hook: written'];
    case 'updated':
      return ['git pre-push hook: was already there, written again'];
    case 'written-after-keeping-older':
      return [`git pre-push hook: written. The hook that was there is kept as ${keptName('pre-push')} and runs first`];
    case 'blocked-by-two-older-hooks':
      return [
        `git pre-push hook: NOT WRITTEN: a pre-push hook that this tool did not write is there, and so is ${keptName('pre-push')}.`,
        '  One of them has to go before the tool can keep the other. Merge the two by hand,',
        '  then run "gotreceipts install" again.',
      ];
  }
}

/** Installs the Claude Code hook entry and returns the lines that say what happened. */
function installAgentPart(root: string, launcher: Launcher): string[] {
  const result = installAgentHook(root, launcher);
  switch (result.outcome) {
    case 'written':
    case 'updated': {
      const lines = [
        result.outcome === 'written'
          ? `Claude Code hook: written into ${SETTINGS_FILE}`
          : `Claude Code hook: was already in ${SETTINGS_FILE}, written again`,
      ];
      if (result.newlyExcluded) lines.push('  That file holds paths of this machine. It is now kept out of git through .git/info/exclude.');
      lines.push('  Claude Code reads its hooks when a session starts, so start a new session.');
      return lines;
    }
    case 'unreadable':
      return [`Claude Code hook: NOT WRITTEN: ${SETTINGS_FILE} could not be read: ${result.reason}. Nothing in it was changed.`];
    case 'tracked':
      return [
        `Claude Code hook: NOT WRITTEN: ${SETTINGS_FILE} is committed in this repository.`,
        '  The entry holds a path of this machine, which does not belong in a committed file.',
      ];
    case 'unsafe-path':
      return ['Claude Code hook: NOT WRITTEN: the folder the tool is in has a quote, a dollar sign or a backtick in its name.'];
  }
}

/** Installs the skill and returns the lines that say what happened. */
function installSkillPart(root: string, launcher: Launcher): string[] {
  const result = installSkill(root, launcher);
  switch (result.outcome) {
    case 'written':
    case 'updated': {
      const lines = [
        result.outcome === 'written'
          ? `Claude Code skill: written into ${SKILL_FILE}`
          : `Claude Code skill: was already in ${SKILL_FILE}, written again`,
      ];
      if (result.newlyExcluded) lines.push('  That file holds a path of this machine. It is now kept out of git through .git/info/exclude.');
      return lines;
    }
    case 'foreign':
      return [`Claude Code skill: NOT WRITTEN: another skill is at ${SKILL_FILE}, and this tool did not write it. It was left as it is.`];
    case 'tracked':
      return [
        `Claude Code skill: NOT WRITTEN: ${SKILL_FILE} is committed in this repository.`,
        '  The skill this tool writes holds a path of this machine, which does not belong in a committed file.',
      ];
    case 'no-source':
      return ['Claude Code skill: NOT WRITTEN: the skill that ships with the tool could not be read.'];
  }
}

export async function installCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  // A policy is needed first: without one, the git hook would block every push.
  const setup = setUp('install', INSTALL_USAGE, args, io);
  if (!setup.ok) return setup.code;
  const { policy, root } = setup;

  const launcher = currentLauncher();
  if (looksTemporary(launcher.cli)) {
    io.out('gotreceipts install: REFUSED: the tool is running from a temporary folder, the kind "npx" downloads into.');
    io.out('A hook that points there would break when that folder is cleaned.');
    io.out('Install the tool first (npm install --save-dev gotreceipts, or npm install --global gotreceipts),');
    io.out('then run "gotreceipts install" again.');
    io.out('Nothing was changed.');
    return EXIT.REFUSED;
  }

  io.out('gotreceipts install:');
  for (const line of [...installGitPart(root, launcher), ...installAgentPart(root, launcher), ...installSkillPart(root, launcher)]) {
    io.out(`  ${line}`);
  }
  io.out('');
  return verdict(io, printReport(io, inspect(root, policy)));
}

export async function uninstallCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const done = readOptions('uninstall', UNINSTALL_USAGE, args, io);
  if (done !== undefined) return done;

  // No policy is needed to leave. A repository with a broken policy must still be able to uninstall.
  const root = repoRoot(process.cwd());
  if (root === undefined) {
    io.err('gotreceipts uninstall: CANNOT RUN: this folder is not inside a git repository');
    return EXIT.CANNOT_RUN;
  }

  let failed = false;
  io.out('gotreceipts uninstall:');

  const place = findHooksFolder(root);
  if (place.kind === 'unknown') {
    io.out('  git pre-push hook: NOT REMOVED: git could not say where its hooks folder is');
    failed = true;
  } else if (place.kind === 'custom') {
    io.out(`  git pre-push hook: git looks for hooks in "${place.setting}". The tool never wrote there, so there is nothing to remove`);
  } else {
    const said = {
      removed: 'removed',
      'removed-and-restored-older': `removed. The hook kept as ${keptName('pre-push')} is back in its place`,
      'not-installed': 'was not installed, nothing to remove',
      'not-ours': 'a hook is there that this tool did not write. It was left as it is',
    }[uninstallHook(place.folder, 'pre-push')];
    io.out(`  git pre-push hook: ${said}`);
  }

  const agent = uninstallAgentHook(root);
  if (agent === 'unreadable') {
    io.out(`  Claude Code hook: NOT REMOVED: ${SETTINGS_FILE} could not be read. Nothing in it was changed`);
    failed = true;
  } else {
    io.out(`  Claude Code hook: ${agent === 'removed' ? `removed from ${SETTINGS_FILE}` : 'was not installed, nothing to remove'}`);
  }

  const skillSaid = {
    removed: `removed from ${SKILL_FILE}`,
    'not-installed': 'was not installed, nothing to remove',
    'not-ours': 'a skill is there that this tool did not write. It was left as it is',
  }[uninstallSkill(root)];
  io.out(`  Claude Code skill: ${skillSaid}`);

  if (failed) return EXIT.REFUSED;
  io.out('From now on, nothing in this clone is checked by this tool.');
  return EXIT.PASS;
}

export async function doctorCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const setup = setUp('doctor', DOCTOR_USAGE, args, io);
  if (!setup.ok) return setup.code;

  io.out('gotreceipts doctor: what is enforced in this clone');
  io.out('');
  const missing = printReport(io, inspect(setup.root, setup.policy));
  const code = verdict(io, missing);
  if (missing.length > 0) io.out('To put the hooks in place: gotreceipts install');
  return code;
}
