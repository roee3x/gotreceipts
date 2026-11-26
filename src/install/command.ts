import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { repoRoot } from '../git.ts';
import type { Io } from '../main.ts';
import { loadPolicy } from '../policy/load.ts';
import type { Policy } from '../policy/policy.ts';
import { inspect, printReport, SHARED_HOOK_LINE } from './doctor.ts';
import { keptName, looksTemporary } from './hook-script.ts';
import { currentLauncher, findHooksFolder, installHook, uninstallHook } from './hooks.ts';

export const INSTALL_USAGE = [
  'Usage: gotreceipts install',
  '',
  'Puts the git hook of this tool into this clone of the repository, and reports what is',
  'enforced from then on and what is not.',
  '',
  '  pre-push    Before every push, each commit that would enter a branch with a gate level',
  '              must have a valid record at that level.',
  '',
  'A hook that is already there is never overwritten. It is kept under the name',
  'pre-push.local, and it runs first. "gotreceipts uninstall" puts it back.',
  '',
  'Hooks do not come with a clone. Run this once in every clone.',
  '',
  'Exit codes: 0 = the hook is in place, 1 = it was not installed, 2 = the command could not run.',
].join('\n');

export const UNINSTALL_USAGE = [
  'Usage: gotreceipts uninstall',
  '',
  'Removes the git hook that "gotreceipts install" wrote, and puts a hook that was kept',
  'aside back in its place. A hook that this tool did not write is never touched.',
  '',
  'Exit codes: 0 = no hook of this tool is left, 2 = the command could not run.',
].join('\n');

export const DOCTOR_USAGE = [
  'Usage: gotreceipts doctor',
  '',
  'Reports what is enforced in this clone of the repository, and what is not.',
  'It changes nothing.',
  '',
  'Exit codes: 0 = the push hook is in place, 1 = it is not, 2 = the command could not run.',
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

function verdict(io: Io, protectedNow: boolean): ExitCode {
  if (protectedNow) {
    io.out('VERDICT: PASS (the push hook is in place)');
    return EXIT.PASS;
  }
  io.out('VERDICT: NOT PROTECTED (the push hook is not in place)');
  return EXIT.REFUSED;
}

export async function installCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  // A policy is needed first: without one, the hook would block every push.
  const setup = setUp('install', INSTALL_USAGE, args, io);
  if (!setup.ok) return setup.code;
  const { policy, root } = setup;

  const refused = (lines: readonly string[]): ExitCode => {
    io.out(`gotreceipts install: REFUSED: ${lines[0] ?? ''}`);
    for (const line of lines.slice(1)) io.out(line);
    io.out('Nothing was changed.');
    return EXIT.REFUSED;
  };

  const launcher = currentLauncher();
  if (looksTemporary(launcher.cli)) {
    return refused([
      'the tool is running from a temporary folder, the kind "npx" downloads into.',
      'A hook that points there would break when that folder is cleaned.',
      'Install the tool first (npm install --save-dev gotreceipts, or npm install --global gotreceipts),',
      'then run "gotreceipts install" again.',
    ]);
  }

  const place = findHooksFolder(root);
  if (place.kind === 'unknown') {
    io.err('gotreceipts install: CANNOT RUN: git could not say where its hooks folder is');
    return EXIT.CANNOT_RUN;
  }
  if (place.kind === 'custom') {
    return refused([
      `git looks for hooks in "${place.setting}" (the setting core.hooksPath).`,
      'Such a folder is usually committed, and a hook written here holds paths of this machine.',
      'Add this line to the pre-push hook in that folder instead:',
      `  ${SHARED_HOOK_LINE}`,
    ]);
  }

  const outcome = installHook(place.folder, 'pre-push', launcher);
  if (outcome === 'blocked-by-two-older-hooks') {
    return refused([
      `a pre-push hook that this tool did not write is there, and so is ${keptName('pre-push')}.`,
      'One of them has to go before the tool can keep the other. Merge the two by hand,',
      'then run "gotreceipts install" again.',
    ]);
  }

  io.out('gotreceipts install: done.');
  if (outcome === 'written') io.out('  pre-push hook: written');
  if (outcome === 'updated') io.out('  pre-push hook: was already there, written again');
  if (outcome === 'written-after-keeping-older') {
    io.out(`  pre-push hook: written. The hook that was there is kept as ${keptName('pre-push')} and runs first`);
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

  const place = findHooksFolder(root);
  if (place.kind === 'unknown') {
    io.err('gotreceipts uninstall: CANNOT RUN: git could not say where its hooks folder is');
    return EXIT.CANNOT_RUN;
  }
  if (place.kind === 'custom') {
    io.out(`gotreceipts uninstall: git looks for hooks in "${place.setting}". The tool never wrote there, so there is nothing to remove.`);
    return EXIT.PASS;
  }

  const outcome = uninstallHook(place.folder, 'pre-push');
  const said = {
    removed: 'pre-push hook: removed',
    'removed-and-restored-older': `pre-push hook: removed. The hook kept as ${keptName('pre-push')} is back in its place`,
    'not-installed': 'pre-push hook: was not installed, nothing to remove',
    'not-ours': 'pre-push hook: a hook is there that this tool did not write. It was left as it is',
  }[outcome];
  io.out('gotreceipts uninstall: done.');
  io.out(`  ${said}`);
  io.out('From now on, a push from this clone is not checked.');
  return EXIT.PASS;
}

export async function doctorCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const setup = setUp('doctor', DOCTOR_USAGE, args, io);
  if (!setup.ok) return setup.code;

  io.out('gotreceipts doctor: what is enforced in this clone');
  io.out('');
  const protectedNow = printReport(io, inspect(setup.root, setup.policy));
  const code = verdict(io, protectedNow);
  if (!protectedNow) io.out('To put the hook in place: gotreceipts install');
  return code;
}
