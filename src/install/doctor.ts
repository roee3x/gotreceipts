import { existsSync } from 'node:fs';

import type { Io } from '../main.ts';
import { protectedPatterns, type Policy } from '../policy/policy.ts';
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
  /** The entry was written by an older version of the tool and is called for fewer tools. */
  | { readonly state: 'outdated' }
  | { readonly state: 'broken'; readonly cli: string | undefined }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable'; readonly reason: string };

export interface Inspection {
  readonly levels: number;
  /** The branch patterns the policy sets a level for. */
  readonly guarded: readonly string[];
  /** How many protected files or patterns the policy lists, on top of the policy file itself. */
  readonly protectedListed: number;
  /** The names of those whose signature counts as an approval. Empty: the policy is not locked. */
  readonly signers: readonly string[];
  /** The branch patterns that ask for an approval of every commit. */
  readonly approvalBranches: readonly string[];
  /** True when the policy says records and approvals travel to the remote. */
  readonly travel: boolean;
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
  return { state: state.current ? 'installed' : 'outdated' };
}

/** Looks at this clone and says what is in place. It changes nothing. */
export function inspect(root: string, policy: Policy): Inspection {
  return {
    levels: policy.levels.length,
    guarded: policy.tiers.map((tier) => tier.branch),
    protectedListed: protectedPatterns(policy).length - 1,
    signers: (policy.approval?.signers ?? []).map((signer) => signer.name),
    approvalBranches: policy.tiers.filter((tier) => tier.needsApproval === true).map((tier) => tier.branch),
    travel: policy.travel === true,
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
    case 'outdated':
      return [
        'OUT OF DATE: the entry was written by an older version of the tool',
        'it stops the merge commands, and it does not ask about edits of protected files',
        'run "gotreceipts install" to write it again',
      ];
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
  const agentCurrent = inspection.claudeCode.state === 'installed';
  // An entry of an older version still stops the merge commands. It only lacks the newer part.
  const agentHook = agentCurrent || inspection.claudeCode.state === 'outdated';

  row('policy file', [
    `OK: ${inspection.levels} ${inspection.levels === 1 ? 'level' : 'levels'}, and a level is set for ${
      inspection.guarded.length === 0 ? 'no branch' : inspection.guarded.join(', ')
    }`,
  ]);
  const locked = inspection.signers.length > 0;
  row(
    'approval',
    locked
      ? [
          `LOCKED: ${inspection.signers.length === 1 ? '1 signer' : `${inspection.signers.length} signers`} (${inspection.signers.join(', ')})`,
          'a change to a protected file needs a signed approval' +
            (inspection.approvalBranches.length === 0 ? '' : `, and so does every commit into ${inspection.approvalBranches.join(', ')}`),
        ]
      : [
          'NOT LOCKED: the policy lists no signer',
          'a change to a protected file, the policy file included, needs nobody\'s signature',
        ],
  );
  row(
    'records',
    inspection.travel
      ? ['TRAVEL: a push, "approve" and "merge" send records and approvals to the remote', 'another clone gets them with "gotreceipts fetch", and "gotreceipts audit" reads them there']
      : ['STAY IN THIS CLONE: another clone, and CI, cannot see them', 'they are sent only when someone runs "gotreceipts send"'],
  );
  row('git pre-push hook', hookLines(inspection.prePush));
  row('Claude Code hook', agentLines(inspection.claudeCode));
  row('Claude Code skill', skillLines(inspection.skill));

  io.out('');
  io.out('This clone stops:');
  if (pushHook) {
    io.out('  - "git push" of a commit that has no valid record, into a branch with a level.');
    io.out('  - A commit that edits the policy file to get itself in. It is judged by the policy that is already on the branch.');
    if (locked) io.out('  - "git push" of a commit that needs an approval and has no valid one. See "approval" above for what needs one.');
  }
  if (inspection.prePush.state === 'broken') io.out('  - Every "git push", because the hook cannot find its tool.');
  if (agentHook) {
    io.out('  - Claude Code running a bare "gh pr merge", the same merge through "gh api", or "git push --no-verify".');
    io.out('    It is told to use "gotreceipts merge", which checks the record first.');
    io.out('  - Claude Code running "gotreceipts approve". An approval is for a person to give, and it is told to hand it over.');
  }
  if (agentCurrent) {
    io.out(`  - Claude Code changing a protected file with its edit tools, without a question to the user first (${protectedSummary(inspection)}).`);
  }
  if (!pushHook && !agentHook && inspection.prePush.state !== 'broken') io.out('  - Nothing. No hook of this tool is in place.');

  io.out('');
  io.out('It does not stop:');
  io.out('  - "git push --no-verify" typed by a person. That option skips every git hook.');
  io.out('  - The merge button on GitHub, or a merge by a command the agent hook does not know: a script, an alias, another tool.');
  io.out('    "gotreceipts audit", run in CI after each push, names such a merge afterwards.');
  io.out('  - Another coding agent than Claude Code, and Claude Code itself when its hook cannot run. That hook is early feedback, not a lock.');
  io.out('  - A push from another clone. Hooks do not come with a clone: run "gotreceipts install" once in each.');
  io.out('  - A record that someone wrote by hand inside the .git folder.');
  if (locked) {
    io.out('  - An approval made with a key that needs no passphrase, or that sits unlocked in the background.');
    io.out('    Whatever runs on this machine can sign with such a key. The signature is as strong as the key is kept.');
  } else {
    io.out('  - A change to the policy file that was merged like any other change. From then on it is the policy.');
    io.out('    Listing a signer in the policy (approval.signers) closes this: such a change then needs a signature.');
  }
  io.out('  - A protected file that is changed by a shell command. The agent hook sees only the edit tools.');
  io.out(
    locked
      ? '    Such a change is named, and refused without an approval, by the push hook and the merge command.'
      : '    Such a change is named in the output of the gate, the push hook and the merge command.',
  );
  io.out('');

  const missing: string[] = [];
  if (!pushHook) missing.push('the push hook');
  if (!agentCurrent) missing.push(agentHook ? 'the current Claude Code hook' : 'the Claude Code hook');
  return missing;
}

/** "the policy file" or "the policy file and 2 more that the policy lists". */
function protectedSummary(inspection: Inspection): string {
  const listed = inspection.protectedListed;
  return listed === 0 ? 'the policy file' : `the policy file and ${listed} more that the policy lists`;
}
