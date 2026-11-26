import { existsSync } from 'node:fs';

import type { Io } from '../main.ts';
import type { Policy } from '../policy/policy.ts';
import { keptName } from './hook-script.ts';
import { findHooksFolder, readHookState, type HookName } from './hooks.ts';

/** What was found about one git hook in this clone. */
export type HookFinding =
  | { readonly state: 'installed'; readonly keptOlder: boolean }
  /** The hook is there, and the tool it calls is not. */
  | { readonly state: 'broken'; readonly cli: string | undefined }
  | { readonly state: 'missing' }
  /** Another hook holds the place. */
  | { readonly state: 'foreign' }
  /** Git looks for hooks in another folder, so the tool does not write one. */
  | { readonly state: 'custom-folder'; readonly setting: string }
  | { readonly state: 'unknown' };

export interface Inspection {
  readonly levels: number;
  /** The branch patterns the policy sets a level for. */
  readonly guarded: readonly string[];
  readonly prePush: HookFinding;
}

function inspectHook(root: string, name: HookName): HookFinding {
  const place = findHooksFolder(root);
  if (place.kind === 'custom') return { state: 'custom-folder', setting: place.setting };
  if (place.kind === 'unknown') return { state: 'unknown' };

  const state = readHookState(place.folder, name);
  if (state.kind === 'none') return { state: 'missing' };
  if (state.kind === 'foreign') return { state: 'foreign' };
  if (state.cli === undefined || !existsSync(state.cli)) return { state: 'broken', cli: state.cli };
  return { state: 'installed', keptOlder: state.keptOlder };
}

/** Looks at this clone and says what is in place. It changes nothing. */
export function inspect(root: string, policy: Policy): Inspection {
  return {
    levels: policy.levels.length,
    guarded: policy.tiers.map((tier) => tier.branch),
    prePush: inspectHook(root, 'pre-push'),
  };
}

/** The line that tells a hook in a shared hooks folder to call the tool. */
export const SHARED_HOOK_LINE = 'gotreceipts hook pre-push "$@"';

function hookLines(finding: HookFinding): string[] {
  switch (finding.state) {
    case 'installed':
      return finding.keptOlder
        ? ['INSTALLED', `an older hook, ${keptName('pre-push')}, runs before it`]
        : ['INSTALLED'];
    case 'broken':
      return [
        finding.cli === undefined
          ? 'BROKEN: the hook does not say which tool it calls'
          : `BROKEN: the hook calls a tool that is no longer there (${finding.cli})`,
        'it blocks every push until "gotreceipts install" is run again',
      ];
    case 'missing':
      return ['NOT INSTALLED'];
    case 'foreign':
      return ['NOT INSTALLED: another pre-push hook is there, and it was not written by gotreceipts'];
    case 'custom-folder':
      return [
        `NOT INSTALLED: git looks for hooks in "${finding.setting}" (the setting core.hooksPath)`,
        'the tool does not write into that folder. Add this line to its pre-push hook:',
        `  ${SHARED_HOOK_LINE}`,
      ];
    case 'unknown':
      return ['UNKNOWN: git could not say where its hooks folder is'];
  }
}

/**
 * Prints what is enforced in this clone and, just as plainly, what is not.
 * Returns true when the push hook is in place and working.
 */
export function printReport(io: Io, inspection: Inspection): boolean {
  const label = (text: string): string => `  ${text.padEnd(20)}`;
  const blank = ' '.repeat(22);
  const protectedNow = inspection.prePush.state === 'installed';

  io.out(
    `${label('policy file')}OK: ${inspection.levels} ${inspection.levels === 1 ? 'level' : 'levels'}, and a level is set for ${
      inspection.guarded.length === 0 ? 'no branch' : inspection.guarded.join(', ')
    }`,
  );
  const [first, ...rest] = hookLines(inspection.prePush);
  io.out(`${label('git pre-push hook')}${first ?? ''}`);
  for (const line of rest) io.out(`${blank}${line}`);

  io.out('');
  io.out('This clone stops:');
  if (protectedNow) {
    io.out('  - "git push" of a commit that has no valid record, into a branch with a level.');
  } else if (inspection.prePush.state === 'broken') {
    io.out('  - Every "git push", because the hook cannot find its tool.');
  } else {
    io.out('  - Nothing. No hook of this tool is in place.');
  }

  io.out('');
  io.out('It does not stop:');
  io.out('  - "git push --no-verify". That option skips every git hook.');
  io.out('  - A merge made on the server: the merge button, or a bare "gh pr merge". Use "gotreceipts merge" for pull requests.');
  io.out('  - A push from another clone. Hooks do not come with a clone: run "gotreceipts install" once in each.');
  io.out('  - A record that someone wrote by hand inside the .git folder.');
  io.out('');

  return protectedNow;
}
