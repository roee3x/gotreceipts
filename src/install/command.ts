import { EXIT, type ExitCode } from '../exit-codes.ts';
import { repoRoot } from '../git.ts';
import type { Io } from '../main.ts';
import { readOptions } from '../options.ts';
import { loadPolicy } from '../policy/load.ts';
import type { Policy } from '../policy/policy.ts';
import { installAgentHook, SETTINGS_FILE, uninstallAgentHook } from './claude-code.ts';
import { inspect, PART, printReport, SHARED_HOOK_LINE } from './doctor.ts';
import { keptName, looksTemporary, type Launcher } from './hook-script.ts';
import { currentLauncher, findHooksFolder, installHook, uninstallHook, type UninstallOutcome } from './hooks.ts';
import { installSkill, SKILL_FILE, uninstallSkill, type SkillUninstall } from './skill.ts';

/**
 * The three commands about the setup of one clone:
 *
 *   install     puts the two hooks and the skill in place, then reports like "doctor"
 *   uninstall   takes out what "install" wrote, and nothing else
 *   doctor      reports what is enforced here and what is not. It changes nothing
 *
 * Each of the three parts (git hook, Claude Code hook, skill) says in its own lines what
 * happened to it. A part that could not be written never stops the other two.
 */

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

// --- what install and doctor share ---

type Setup = { readonly ok: true; readonly policy: Policy; readonly root: string } | { readonly ok: false; readonly code: ExitCode };

/** Reads the options, finds the repository, reads the policy. These commands take no option but --help. */
function setUp(command: string, usage: string, args: readonly string[], io: Io): Setup {
  const start = readOptions({ command, usage }, args, io);
  if (start.done) return { ok: false, code: start.code };

  const loaded = loadPolicy(process.cwd());
  if (!loaded.ok) return { ok: false, code: start.cannotRun(...loaded.errors) };
  if (loaded.root === undefined) return { ok: false, code: start.cannotRun('this folder is not inside a git repository') };
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

/** The lines of one part: its name before what it says, and whatever says more set in below. */
function partLines(name: string, [first = '', ...more]: readonly string[]): string[] {
  return [`${name}: ${first}`, ...more.map((line) => `  ${line}`)];
}

// --- install ---

/** Installs the git hook, and says what happened. */
function installGitHook(root: string, launcher: Launcher): string[] {
  const place = findHooksFolder(root);
  if (place.kind === 'unknown') return ['NOT WRITTEN: git could not say where its hooks folder is'];
  if (place.kind === 'custom') {
    return [
      `NOT WRITTEN: git looks for hooks in "${place.setting}" (the setting core.hooksPath).`,
      'Such a folder is usually committed, and a hook written here holds paths of this machine.',
      'Add this line to the pre-push hook in that folder instead:',
      `  ${SHARED_HOOK_LINE}`,
    ];
  }
  switch (installHook(place.folder, 'pre-push', launcher)) {
    case 'written':
      return ['written'];
    case 'updated':
      return ['was already there, written again'];
    case 'written-after-keeping-older':
      return [`written. The hook that was there is kept as ${keptName('pre-push')} and runs first`];
    case 'blocked-by-two-older-hooks':
      return [
        `NOT WRITTEN: a pre-push hook that this tool did not write is there, and so is ${keptName('pre-push')}.`,
        'One of them has to go before the tool can keep the other. Merge the two by hand,',
        'then run "gotreceipts install" again.',
      ];
  }
}

/** Installs the Claude Code hook entry, and says what happened. */
function installAgentEntry(root: string, launcher: Launcher): string[] {
  const result = installAgentHook(root, launcher);
  switch (result.outcome) {
    case 'written':
    case 'updated':
      return [
        result.outcome === 'written' ? `written into ${SETTINGS_FILE}` : `was already in ${SETTINGS_FILE}, written again`,
        ...(result.newlyExcluded ? ['That file holds paths of this machine. It is now kept out of git through .git/info/exclude.'] : []),
        'Claude Code reads its hooks when a session starts, so start a new session.',
      ];
    case 'unreadable':
      return [`NOT WRITTEN: ${SETTINGS_FILE} could not be read: ${result.reason}. Nothing in it was changed.`];
    case 'tracked':
      return [
        `NOT WRITTEN: ${SETTINGS_FILE} is committed in this repository.`,
        'The entry holds a path of this machine, which does not belong in a committed file.',
      ];
    case 'unsafe-path':
      return ['NOT WRITTEN: the folder the tool is in has a quote, a dollar sign or a backtick in its name.'];
  }
}

/** Installs the skill, and says what happened. */
function installTheSkill(root: string, launcher: Launcher): string[] {
  const result = installSkill(root, launcher);
  switch (result.outcome) {
    case 'written':
    case 'updated':
      return [
        result.outcome === 'written' ? `written into ${SKILL_FILE}` : `was already in ${SKILL_FILE}, written again`,
        ...(result.newlyExcluded ? ['That file holds a path of this machine. It is now kept out of git through .git/info/exclude.'] : []),
      ];
    case 'foreign':
      return [`NOT WRITTEN: another skill is at ${SKILL_FILE}, and this tool did not write it. It was left as it is.`];
    case 'tracked':
      return [
        `NOT WRITTEN: ${SKILL_FILE} is committed in this repository.`,
        'The skill this tool writes holds a path of this machine, which does not belong in a committed file.',
      ];
    case 'no-source':
      return ['NOT WRITTEN: the skill that ships with the tool could not be read.'];
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
  const said = [
    ...partLines(PART.gitHook, installGitHook(root, launcher)),
    ...partLines(PART.agentHook, installAgentEntry(root, launcher)),
    ...partLines(PART.skill, installTheSkill(root, launcher)),
  ];
  for (const line of said) io.out(`  ${line}`);
  io.out('');
  return verdict(io, printReport(io, inspect(root, policy)));
}

// --- uninstall ---

/** What one part says after "uninstall". `failed` is true when something of this tool is still there. */
interface Removal {
  readonly said: string;
  readonly failed: boolean;
}

const GIT_HOOK_REMOVED: Readonly<Record<UninstallOutcome, string>> = {
  removed: 'removed',
  'removed-and-restored-older': `removed. The hook kept as ${keptName('pre-push')} is back in its place`,
  'not-installed': 'was not installed, nothing to remove',
  'not-ours': 'a hook is there that this tool did not write. It was left as it is',
};

const SKILL_REMOVED: Readonly<Record<SkillUninstall, string>> = {
  removed: `removed from ${SKILL_FILE}`,
  'not-installed': 'was not installed, nothing to remove',
  'not-ours': 'a skill is there that this tool did not write. It was left as it is',
};

function removeGitHook(root: string): Removal {
  const place = findHooksFolder(root);
  if (place.kind === 'unknown') return { said: 'NOT REMOVED: git could not say where its hooks folder is', failed: true };
  if (place.kind === 'custom') {
    return { said: `git looks for hooks in "${place.setting}". The tool never wrote there, so there is nothing to remove`, failed: false };
  }
  return { said: GIT_HOOK_REMOVED[uninstallHook(place.folder, 'pre-push')], failed: false };
}

function removeAgentEntry(root: string): Removal {
  switch (uninstallAgentHook(root)) {
    case 'unreadable':
      return { said: `NOT REMOVED: ${SETTINGS_FILE} could not be read. Nothing in it was changed`, failed: true };
    case 'removed':
      return { said: `removed from ${SETTINGS_FILE}`, failed: false };
    case 'not-installed':
      return { said: 'was not installed, nothing to remove', failed: false };
  }
}

function removeTheSkill(root: string): Removal {
  return { said: SKILL_REMOVED[uninstallSkill(root)], failed: false };
}

export async function uninstallCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'uninstall', usage: UNINSTALL_USAGE }, args, io);
  if (start.done) return start.code;

  // No policy is needed to leave. A repository with a broken policy must still be able to uninstall.
  const root = repoRoot(process.cwd());
  if (root === undefined) return start.cannotRun('this folder is not inside a git repository');

  io.out('gotreceipts uninstall:');
  const parts: readonly (readonly [name: string, remove: (root: string) => Removal])[] = [
    [PART.gitHook, removeGitHook],
    [PART.agentHook, removeAgentEntry],
    [PART.skill, removeTheSkill],
  ];
  // Each part is tried, whatever happened to the one before it.
  let failed = false;
  for (const [name, remove] of parts) {
    const removal = remove(root);
    io.out(`  ${name}: ${removal.said}`);
    if (removal.failed) failed = true;
  }

  if (failed) return EXIT.REFUSED;
  io.out('From now on, nothing in this clone is checked by this tool.');
  return EXIT.PASS;
}

// --- doctor ---

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
