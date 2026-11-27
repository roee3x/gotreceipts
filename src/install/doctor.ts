import { existsSync } from 'node:fs';

import type { Io } from '../main.ts';
import { protectedPatterns, type Policy } from '../policy/policy.ts';
import { readAgentState, SETTINGS_FILE } from './claude-code.ts';
import { keptName } from './hook-script.ts';
import { currentLauncher, findHooksFolder, readHookState, type HookName } from './hooks.ts';
import { readSkillState, SKILL_FILE, type SkillState } from './skill.ts';

/**
 * What "doctor" and "install" say about one clone. The file has three parts:
 *
 *   looking     what is in place here: the policy, the two hooks and the skill. It changes nothing.
 *   the rows    one row for each of them, in words.
 *   two lists   what this clone stops from now on, and, just as plainly, what it does not.
 */

// --- looking ---

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

/** True when the tool a hook calls is still where the hook says. */
function isThere(cli: string | undefined): cli is string {
  return cli !== undefined && existsSync(cli);
}

function inspectHook(root: string, name: HookName): HookFinding {
  const place = findHooksFolder(root);
  if (place.kind === 'custom') return { state: 'custom-folder', setting: place.setting };
  if (place.kind === 'unknown') return { state: 'unknown' };

  const state = readHookState(place.folder, name);
  if (state.kind === 'none') return { state: 'missing' };
  if (state.kind === 'foreign') return { state: 'foreign' };
  if (!isThere(state.cli)) return { state: 'broken', cli: state.cli };
  return { state: 'installed', keptOlder: state.keptOlder };
}

function inspectAgent(root: string): AgentFinding {
  const state = readAgentState(root);
  if (state.kind === 'none') return { state: 'missing' };
  if (state.kind === 'unreadable') return { state: 'unreadable', reason: state.reason };
  if (!isThere(state.cli)) return { state: 'broken', cli: state.cli };
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

/** The four facts the two lists and the verdict turn on. */
interface Standing {
  /** The push hook is in place and can find its tool. */
  readonly pushHook: boolean;
  /** The agent hook stops the merge commands. An entry of an older version still does. */
  readonly agentHook: boolean;
  /** The agent hook is the one this version writes, so it also asks about edits of protected files. */
  readonly agentCurrent: boolean;
  /** The policy lists a signer, so an approval can be asked for. */
  readonly locked: boolean;
}

function standingOf(inspection: Inspection): Standing {
  const agentCurrent = inspection.claudeCode.state === 'installed';
  return {
    pushHook: inspection.prePush.state === 'installed',
    agentHook: agentCurrent || inspection.claudeCode.state === 'outdated',
    agentCurrent,
    locked: inspection.signers.length > 0,
  };
}

// --- the rows ---

/** The names of the three parts "install" puts in place. The report and the lines of "install" use the same ones. */
export const PART = {
  gitHook: 'git pre-push hook',
  agentHook: 'Claude Code hook',
  skill: 'Claude Code skill',
} as const;

/** The line that tells a hook in a shared hooks folder to call the tool. */
export const SHARED_HOOK_LINE = 'gotreceipts hook pre-push "$@"';

function policyLines(inspection: Inspection): string[] {
  const levels = `${inspection.levels} ${inspection.levels === 1 ? 'level' : 'levels'}`;
  const branches = inspection.guarded.length === 0 ? 'no branch' : inspection.guarded.join(', ');
  return [`OK: ${levels}, and a level is set for ${branches}`];
}

function approvalLines(inspection: Inspection): string[] {
  const { signers, approvalBranches } = inspection;
  if (signers.length === 0) {
    return ['NOT LOCKED: the policy lists no signer', 'a change to a protected file, the policy file included, needs nobody\'s signature'];
  }
  const count = signers.length === 1 ? '1 signer' : `${signers.length} signers`;
  const everyCommit = approvalBranches.length === 0 ? '' : `, and so does every commit into ${approvalBranches.join(', ')}`;
  return [`LOCKED: ${count} (${signers.join(', ')})`, `a change to a protected file needs a signed approval${everyCommit}`];
}

function recordLines(inspection: Inspection): string[] {
  return inspection.travel
    ? [
        'TRAVEL: a push, "approve" and "merge" send records and approvals to the remote',
        'another clone gets them with "gotreceipts fetch", and "gotreceipts audit" reads them there',
      ]
    : ['STAY IN THIS CLONE: another clone, and CI, cannot see them', 'they are sent only when someone runs "gotreceipts send"'];
}

function hookLines(finding: HookFinding): string[] {
  switch (finding.state) {
    case 'installed':
      return finding.keptOlder ? ['INSTALLED', `an older hook, ${keptName('pre-push')}, runs before it`] : ['INSTALLED'];
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

/** One row of the report: a name, what was found, and any lines that say more about it. */
type Row = readonly [name: string, lines: readonly string[]];

function rowsOf(inspection: Inspection): Row[] {
  return [
    ['policy file', policyLines(inspection)],
    ['approval', approvalLines(inspection)],
    ['records', recordLines(inspection)],
    [PART.gitHook, hookLines(inspection.prePush)],
    [PART.agentHook, agentLines(inspection.claudeCode)],
    [PART.skill, skillLines(inspection.skill)],
  ];
}

// --- the two lists ---

/** One point of a list: its first line, and any lines that go on from it. */
type Point = readonly string[];

/** "the policy file" or "the policy file and 2 more that the policy lists". */
function protectedSummary(inspection: Inspection): string {
  const listed = inspection.protectedListed;
  return listed === 0 ? 'the policy file' : `the policy file and ${listed} more that the policy lists`;
}

/** What this clone stops. Every point follows from a hook that is in place. */
function stops(inspection: Inspection): Point[] {
  const { pushHook, agentHook, agentCurrent, locked } = standingOf(inspection);
  const points: Point[] = [];

  if (pushHook) {
    points.push(
      ['"git push" of a commit that has no valid record, into a branch with a level.'],
      ['A commit that edits the policy file to get itself in. It is judged by the policy that is already on the branch.'],
    );
    if (locked) points.push(['"git push" of a commit that needs an approval and has no valid one. See "approval" above for what needs one.']);
  }
  if (inspection.prePush.state === 'broken') points.push(['Every "git push", because the hook cannot find its tool.']);
  if (agentHook) {
    points.push(
      [
        'Claude Code running a bare "gh pr merge", the same merge through "gh api", or "git push --no-verify".',
        'It is told to use "gotreceipts merge", which checks the record first.',
      ],
      ['Claude Code running "gotreceipts approve". An approval is for a person to give, and it is told to hand it over.'],
    );
  }
  if (agentCurrent) {
    points.push([
      `Claude Code changing a protected file with its edit tools, without a question to the user first (${protectedSummary(inspection)}).`,
    ]);
  }
  return points.length > 0 ? points : [['Nothing. No hook of this tool is in place.']];
}

/** What this clone does not stop, whatever is installed. Said as plainly as the first list. */
function doesNotStop(inspection: Inspection): Point[] {
  const { locked } = standingOf(inspection);
  return [
    ['"git push --no-verify" typed by a person. That option skips every git hook.'],
    [
      'The merge button on GitHub, or a merge by a command the agent hook does not know: a script, an alias, another tool.',
      '"gotreceipts audit", run in CI after each push, names such a merge afterwards.',
    ],
    ['Another coding agent than Claude Code, and Claude Code itself when its hook cannot run. That hook is early feedback, not a lock.'],
    ['A push from another clone. Hooks do not come with a clone: run "gotreceipts install" once in each.'],
    ['A record that someone wrote by hand inside the .git folder.'],
    locked
      ? [
          'An approval made with a key that needs no passphrase, or that sits unlocked in the background.',
          'Whatever runs on this machine can sign with such a key. The signature is as strong as the key is kept.',
        ]
      : [
          'A change to the policy file that was merged like any other change. From then on it is the policy.',
          'Listing a signer in the policy (approval.signers) closes this: such a change then needs a signature.',
        ],
    [
      'A protected file that is changed by a shell command. The agent hook sees only the edit tools.',
      locked
        ? 'Such a change is named, and refused without an approval, by the push hook and the merge command.'
        : 'Such a change is named in the output of the gate, the push hook and the merge command.',
    ],
  ];
}

/** The parts that are not in place. An empty list means everything is. */
function missingOf(inspection: Inspection): string[] {
  const { pushHook, agentHook, agentCurrent } = standingOf(inspection);
  return [
    ...(pushHook ? [] : ['the push hook']),
    ...(agentCurrent ? [] : [agentHook ? 'the current Claude Code hook' : 'the Claude Code hook']),
  ];
}

// --- printing ---

/** The width of the column of names in the rows. */
const NAME_WIDTH = 20;

function printRow(io: Io, [name, lines]: Row): void {
  const [first = '', ...more] = lines;
  io.out(`  ${name.padEnd(NAME_WIDTH)}${first}`);
  for (const line of more) io.out(`${' '.repeat(NAME_WIDTH + 2)}${line}`);
}

function printList(io: Io, title: string, points: readonly Point[]): void {
  io.out(title);
  for (const [first = '', ...more] of points) {
    io.out(`  - ${first}`);
    for (const line of more) io.out(`    ${line}`);
  }
}

/**
 * Prints what is enforced in this clone and, just as plainly, what is not.
 * Returns the parts that are not in place. An empty list means everything is.
 */
export function printReport(io: Io, inspection: Inspection): string[] {
  for (const row of rowsOf(inspection)) printRow(io, row);
  io.out('');
  printList(io, 'This clone stops:', stops(inspection));
  io.out('');
  printList(io, 'It does not stop:', doesNotStop(inspection));
  io.out('');
  return missingOf(inspection);
}
