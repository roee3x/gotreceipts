import { existsSync } from 'node:fs';

import type { Io } from '../main.ts';
import type { Policy } from '../policy/policy.ts';
import { readAgentState, SETTINGS_FILE } from './claude-code.ts';
import { keptName } from './hook-script.ts';
import { currentLauncher, findHooksFolder, readHookState, type HookName } from './hooks.ts';
import { readSkillState, SKILL_FILE, type SkillState } from './skill.ts';

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

/** What was found about the Claude Code hook in this clone. */
export type AgentFinding =
  | { readonly state: 'installed' }
  | { readonly state: 'broken'; readonly cli: string | undefined }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable'; readonly reason: string };

export interface Inspection {
  readonly levels: number;
  /** The branch patterns the policy sets a level for. */
  readonly guarded: readonly string[];
  readonly prePush: HookFinding;
  readonly claudeCode: AgentFinding;
  /** The skill explains the gate to the agent. It is reported, and it is no part of the verdict. */
  readonly skill: SkillState;
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

function inspectAgent(root: string): AgentFinding {
  const state = readAgentState(root);
  if (state.kind === 'none') return { state: 'missing' };
  if (state.kind === 'unreadable') return { state: 'unreadable', reason: state.reason };
  if (state.cli === undefined || !existsSync(state.cli)) return { state: 'broken', cli: state.cli };
  return { state: 'installed' };
}

/** Looks at this clone and says what is in place. It changes nothing. */
export function inspect(root: string, policy: Policy): Inspection {
  return {
    levels: policy.levels.length,
    guarded: policy.tiers.map((tier) => tier.branch),
    prePush: inspectHook(root, 'pre-push'),
    claudeCode: inspectAgent(root),
    skill: readSkillState(root, currentLauncher()),
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

function agentLines(finding: AgentFinding): string[] {
  switch (finding.state) {
    case 'installed':
      return ['INSTALLED'];
    case 'broken':
      return [
        finding.cli === undefined
          ? 'BROKEN: the entry does not say which tool it calls'
          : `BROKEN: the entry calls a tool that is no longer there (${finding.cli})`,
        'the agent is not stopped until "gotreceipts install" is run again',
      ];
    case 'missing':
      return ['NOT INSTALLED'];
    case 'unreadable':
      return [`UNKNOWN: ${SETTINGS_FILE} could not be read: ${finding.reason}`];
  }
}

function skillLines(state: SkillState): string[] {
  switch (state) {
    case 'current':
      return ['INSTALLED', 'it tells the agent how to work with the gate. It stops nothing'];
    case 'outdated':
      return ['OUT OF DATE: it is not the text this version of the tool writes', 'run "gotreceipts install" to write it again'];
    case 'none':
      return ['NOT INSTALLED'];
    case 'foreign':
      return [`NOT INSTALLED: another skill is at ${SKILL_FILE}, and it was not written by gotreceipts`];
    case 'no-source':
      return ['UNKNOWN: the skill that ships with the tool could not be read'];
  }
}

/**
 * Prints what is enforced in this clone and, just as plainly, what is not.
 * Returns the parts that are not in place. An empty list means everything is.
 */
export function printReport(io: Io, inspection: Inspection): string[] {
  const label = (text: string): string => `  ${text.padEnd(20)}`;
  const blank = ' '.repeat(22);
  const row = (name: string, lines: readonly string[]): void => {
    io.out(`${label(name)}${lines[0] ?? ''}`);
    for (const line of lines.slice(1)) io.out(`${blank}${line}`);
  };
  const pushHook = inspection.prePush.state === 'installed';
  const agentHook = inspection.claudeCode.state === 'installed';

  row('policy file', [
    `OK: ${inspection.levels} ${inspection.levels === 1 ? 'level' : 'levels'}, and a level is set for ${
      inspection.guarded.length === 0 ? 'no branch' : inspection.guarded.join(', ')
    }`,
  ]);
  row('git pre-push hook', hookLines(inspection.prePush));
  row('Claude Code hook', agentLines(inspection.claudeCode));
  row('Claude Code skill', skillLines(inspection.skill));

  io.out('');
  io.out('This clone stops:');
  if (pushHook) {
    io.out('  - "git push" of a commit that has no valid record, into a branch with a level.');
    io.out('  - A commit that edits the policy file to get itself in. It is judged by the policy that is already on the branch.');
  }
  if (inspection.prePush.state === 'broken') io.out('  - Every "git push", because the hook cannot find its tool.');
  if (agentHook) {
    io.out('  - Claude Code running a bare "gh pr merge", the same merge through "gh api", or "git push --no-verify".');
    io.out('    It is told to use "gotreceipts merge", which checks the record first.');
  }
  if (!pushHook && !agentHook && inspection.prePush.state !== 'broken') io.out('  - Nothing. No hook of this tool is in place.');

  io.out('');
  io.out('It does not stop:');
  io.out('  - "git push --no-verify" typed by a person. That option skips every git hook.');
  io.out('  - The merge button on GitHub, or a merge by a command the agent hook does not know: a script, an alias, another tool.');
  io.out('  - Another coding agent than Claude Code, and Claude Code itself when its hook cannot run. That hook is early feedback, not a lock.');
  io.out('  - A push from another clone. Hooks do not come with a clone: run "gotreceipts install" once in each.');
  io.out('  - A record that someone wrote by hand inside the .git folder.');
  io.out('  - A change to the policy file that was merged like any other change. From then on it is the policy.');
  io.out('');

  const missing: string[] = [];
  if (!pushHook) missing.push('the push hook');
  if (!agentHook) missing.push('the Claude Code hook');
  return missing;
}
