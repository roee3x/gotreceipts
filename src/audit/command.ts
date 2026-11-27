import { notCounting, type ApprovalDecision } from '../approval/judge.ts';
import { shownAge } from '../clock.ts';
import { proofOf, rulesFor } from '../door/judge.ts';
import { approvalNotChecked } from '../door/report.ts';
import { EXIT, type ExitCode } from '../exit-codes.ts';
import { isNoCommit, remoteBranch, repoRoot, resolveCommit, shortId, treeOf } from '../git.ts';
import type { Io } from '../main.ts';
import { readOptions } from '../options.ts';
import { protectedLine } from '../policy/committed.ts';
import { fetchReceipts, pickRemote } from '../travel/remote.ts';
import { detailOf, type Decision } from '../verify/decide.ts';
import { commitTime, entriesOf, isShallow, ownLine, type Entry } from './entries.ts';

export const AUDIT_USAGE = [
  'Usage: gotreceipts audit <branch> [options]',
  '',
  'Looks back at what entered a branch, and says for each entry whether it had what the policy',
  'asked for. It changes nothing and stops nothing: it reports.',
  '',
  'It is meant to run on the remote\'s side, in CI, after every push to a guarded branch. A merge',
  'that went around the tool, through the merge button or a push without the hook, then turns',
  'the run red.',
  '',
  'An entry is one thing that moved the branch:',
  '  - a merge commit. What entered is the commit that was merged in.',
  '  - commits pushed straight onto the branch. They count as one push, and what entered is',
  '    the newest of them.',
  '',
  'Each entry is judged by the policy the branch held just before it, as of the time it entered:',
  '  1. A valid record of the commit, at the level the branch needs.',
  '  2. A valid signed approval, when the branch asks for one or a protected file changed.',
  '  3. For a merge: the result holds exactly the files of the commit that was merged in.',
  '',
  'The records and approvals are the ones the remote holds. A policy that says "travel": true',
  'has the push hook, "approve" and "merge" send them there. A record is a plain file, so a',
  'record alone shows that the entry went through the tool, not that nobody could have made it',
  'up. The approval is a signature, and that cannot be made up.',
  '',
  'Options:',
  '  --since <commit>  Look at everything that entered after this commit. Without it, only the',
  '                    last entry is looked at. An id of only zeros, which CI gives for a new',
  '                    branch, counts as "without it"',
  '  --remote <name>   The remote to ask. Default: "origin", or the only remote there is',
  '  -h, --help        Show this help',
  '',
  'It needs the whole history. In CI, check out with all of it (for GitHub: fetch-depth: 0).',
  '',
  'Exit codes: 0 = every entry had what was asked, 1 = at least one had not, 2 = it could not be checked.',
].join('\n');

// --- judging one entry ---

/** "ok": it had what was asked. "lacking": it had not. "unchecked": it could not be found out, which is never a pass. */
type Outcome = 'ok' | 'lacking' | 'unchecked';

/** What was found out about an entry, or about one of the things asked of it: the outcome, and the lines that say it. */
interface Judged {
  readonly outcome: Outcome;
  readonly lines: readonly string[];
}

const NOTHING_TO_SAY: Judged = { outcome: 'ok', lines: [] };

function notChecked(reason: string): string {
  return `could not be checked: ${reason}`;
}

/**
 * Puts the parts of a judgement together, in their order. A part that could not be checked
 * ends it: the entry is then not checked, whatever the other parts say.
 */
function together(parts: readonly Judged[]): Judged {
  const lines: string[] = [];
  let outcome: Outcome = 'ok';
  for (const part of parts) {
    lines.push(...part.lines);
    if (part.outcome === 'unchecked') return { outcome: 'unchecked', lines };
    if (part.outcome === 'lacking') outcome = 'lacking';
  }
  return { outcome, lines };
}

/**
 * The doors ask their question as of now. The audit asks it as of the time the commit entered.
 * So what a door calls "dated in the future" is here: made after the commit was already in.
 * The audit says that in its own sentence, picked by the reason's code.
 */
const MADE_TOO_LATE = 'it was made after the commit had already entered the branch';

/** For a merge: whether the result holds exactly the files of the commit that was merged in. */
function resultFound(root: string, entry: Entry): Judged {
  if (entry.kind !== 'merge') return NOTHING_TO_SAY;
  const result = treeOf(root, entry.on);
  const tested = treeOf(root, entry.entered);
  if (result === undefined || tested === undefined) {
    return { outcome: 'unchecked', lines: [notChecked('git could not read the files of the merge')] };
  }
  if (result === tested) return NOTHING_TO_SAY;
  return {
    outcome: 'lacking',
    lines: [`result: NOT WHAT WAS TESTED. The merge holds files that are not the same as in commit ${shortId(entry.entered)}`],
  };
}

function recordFound(record: Decision, level: string): Judged {
  if (record.ok) {
    return { outcome: 'ok', lines: [`record: ${record.record.level} record, passed ${shownAge(record.ageHours)} hours before, as level ${level} asked`] };
  }
  const details = record.looked.map(({ about, problem, sentence }) => detailOf({ about, sentence: problem === 'from-the-future' ? MADE_TOO_LATE : sentence }));
  return {
    outcome: 'lacking',
    lines: [`record: NONE THAT COUNTS for level ${level} (${record.summary})`, ...details.map((detail) => `  ${detail}`)],
  };
}

function approvalFound(approval: ApprovalDecision): Judged {
  switch (approval.kind) {
    case 'not-needed':
      return NOTHING_TO_SAY;
    case 'not-locked':
      return {
        outcome: 'ok',
        lines: ['approval: not asked for. That policy listed no signer, so a change to a protected file needed nobody\'s signature'],
      };
    case 'approved':
      return {
        outcome: 'ok',
        lines: [`approval: by ${approval.signer}, ${shownAge(approval.ageHours)} hours before. Needed because ${approval.reasons.join(', and ')}`],
      };
    case 'refused': {
      const why = approval.problem === 'from-the-future' ? notCounting(MADE_TOO_LATE) : approval.detail;
      return { outcome: 'lacking', lines: [`approval: NONE THAT COUNTS (${why}). Needed because ${approval.reasons.join(', and ')}`] };
    }
    case 'cannot-check':
      return { outcome: 'unchecked', lines: [notChecked(approvalNotChecked(approval.reason))] };
  }
}

/** Judges one entry. It reads the remote and the repository, and prints nothing. */
function judgeEntry(root: string, remote: string, branch: string, entry: Entry): Judged {
  const ok = (...lines: readonly string[]): Judged => ({ outcome: 'ok', lines });

  if (entry.before === undefined) return ok('the history of the branch starts here. Nothing was there to ask');
  if (entry.kind === 'many-parents') {
    return {
      outcome: 'lacking',
      lines: ['more than two lines of history meet in this commit, so which commit had to bring its record cannot be told'],
    };
  }

  // 1. The rules: the policy the branch held just before. What the entry itself did to the policy file does not count.
  const shown = `"${branch}" before`;
  const rules = rulesFor(root, entry.on, { branch, commit: entry.before, shown });
  if (!rules.ok) return { outcome: 'unchecked', lines: rules.errors.map(notChecked) };
  const { source, tier } = rules;
  if (source.kind === 'own') return ok(`"${branch}" held no policy before this, so nothing was asked`);
  const policyLine = `policy: the one "${branch}" held before, at commit ${shortId(entry.before)}`;
  if (tier === undefined) return ok(policyLine, `that policy set no level for "${branch}", so nothing was asked`);
  const asked = ok(policyLine, ...(source.protectedChanged.length > 0 ? [protectedLine(source.protectedChanged, shown)] : []));
  const unchecked = (reason: string): Judged => together([asked, { outcome: 'unchecked', lines: [notChecked(reason)] }]);

  // 2. The time the question is asked for: when the commit entered.
  const when = commitTime(root, entry.on);
  if (when === undefined) return unchecked(`git could not say when commit ${shortId(entry.on)} was made`);

  // 3. What the remote holds for the commit that entered. Nothing is believed because it is
  //    there: the record and the approval are judged like any other.
  const got = fetchReceipts(root, remote, entry.entered, Date.now());
  if (got.kind === 'error') {
    return unchecked(`${remote} could not be asked for the record of commit ${shortId(entry.entered)}: ${got.reason}`);
  }

  // 4. The same question the doors ask, about the commit that entered, as of the time it entered.
  const proof = proofOf(root, rules, { commit: entry.entered, level: tier.level, branch, now: when });
  return together([asked, resultFound(root, entry), recordFound(proof.record, tier.level), approvalFound(proof.approval)]);
}

// --- the report ---

const MARK: Record<Outcome, string> = { ok: 'OK', lacking: 'NOT AS ASKED', unchecked: 'NOT CHECKED' };

function headline(entry: Entry): string {
  const on = shortId(entry.on);
  if (entry.kind === 'merge') return `${on} merged commit ${shortId(entry.entered)}`;
  if (entry.kind === 'many-parents') return `${on} a merge of more than two lines of history`;
  return `${on} pushed straight onto the branch (${entry.commits === 1 ? '1 commit' : `${entry.commits} commits`})`;
}

/** The verdict over all entries. One that could not be checked outweighs one that had not what was asked. */
function verdict(io: Io, branch: string, count: Readonly<Record<Outcome, number>>): ExitCode {
  const total = count.ok + count.lacking + count.unchecked;
  const of = (n: number): string => (total === 1 ? 'the entry' : `${n} of ${total} entries`);

  if (count.unchecked > 0) {
    io.out(`VERDICT: NOT CHECKED (${of(count.unchecked)} into "${branch}" could not be checked). That is never a pass.`);
    return EXIT.CANNOT_RUN;
  }
  if (count.lacking > 0) {
    io.out(`VERDICT: FAIL (${of(count.lacking)} into "${branch}" had not what the policy asked for)`);
    io.out('What entered is already on the branch. A record or an approval that is made now does not count:');
    io.out('it is not what opened the door. One that was made in time and never sent still does:');
    io.out('gotreceipts send <commit>, in the clone that holds it. Then run the audit again.');
    return EXIT.REFUSED;
  }
  io.out(
    total === 1
      ? `VERDICT: PASS (the entry into "${branch}" had what the policy asked for)`
      : `VERDICT: PASS (${total} entries into "${branch}", each with what the policy asked for)`,
  );
  return EXIT.PASS;
}

export async function auditCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'audit', usage: AUDIT_USAGE, values: ['since', 'remote'], positionals: true }, args, io);
  if (start.done) return start.code;
  const { options, positionals, cannotRun } = start;

  const branch = positionals[0];
  if (positionals.length !== 1 || branch === undefined) return cannotRun('name one branch, for example: gotreceipts audit main');

  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');
  // In a clone with only part of the history, a commit can look as if it had no parent. An
  // audit that read that as "the history starts here" would pass everything.
  if (isShallow(root)) {
    return cannotRun(
      'this clone holds only part of the history, so what entered the branch cannot be read. Get all of it first (git fetch --unshallow; in a GitHub workflow: fetch-depth: 0)',
    );
  }

  const picked = pickRemote(root, options.remote);
  if (!picked.ok) return cannotRun(picked.reason);
  const remote = picked.name;

  // 1. The branch as the remote has it now, asked from the remote itself.
  const onRemote = remoteBranch(root, remote, branch);
  if (onRemote.kind === 'unknown') return cannotRun(`the remote "${remote}" holds no branch "${branch}", or did not answer`);
  if (onRemote.kind === 'not-downloaded') return cannotRun(`the newest commit of "${branch}" could not be downloaded`);
  const tip = onRemote.commit;

  // 2. What entered it, oldest first: the order in which it entered.
  let since: string | undefined;
  if (options.since !== undefined && !isNoCommit(options.since)) {
    since = resolveCommit(root, options.since);
    if (since === undefined) return cannotRun(`there is no commit "${options.since}"`);
  }
  const line = ownLine(root, tip, since);
  if (!line.ok) return cannotRun(line.reason);
  const entries = entriesOf(line.steps).reverse();

  io.out(
    since === undefined
      ? `gotreceipts audit: the last entry into "${branch}" on ${remote}`
      : `gotreceipts audit: what entered "${branch}" on ${remote} after commit ${shortId(since)}`,
  );
  if (entries.length === 0) {
    io.out(`VERDICT: PASS (nothing entered "${branch}" after commit ${shortId(since ?? tip)})`);
    return EXIT.PASS;
  }

  // 3. Each entry, judged and then printed.
  const count: Record<Outcome, number> = { ok: 0, lacking: 0, unchecked: 0 };
  for (const entry of entries) {
    const judged = judgeEntry(root, remote, branch, entry);
    count[judged.outcome] += 1;
    io.out(`  ${headline(entry)}: ${MARK[judged.outcome]}`);
    for (const each of judged.lines) io.out(`      ${each}`);
  }
  return verdict(io, branch, count);
}
