import { EXIT, type ExitCode } from '../exit-codes.ts';
import { repoRoot, shortId } from '../git.ts';
import type { Io } from '../main.ts';
import { commitAskedFor, readOptions } from '../options.ts';
import { countOf, RECEIPTS_PREFIX } from './receipts.ts';
import { fetchReceipts, pickRemote, sendReceipts } from './remote.ts';

const WHERE = [
  `On the remote they are kept under a name of their own, ${RECEIPTS_PREFIX}<commit>. That is not a`,
  'branch and not a tag: a normal clone or fetch does not download it, and it is not shown',
  'among the branches.',
];

export const SEND_USAGE = [
  'Usage: gotreceipts send [commit] [options]',
  '',
  'Sends the records and the approvals this clone holds for one commit to the remote, so that',
  'another clone, or CI, can fetch them. Without a commit, the one that is checked out.',
  '',
  ...WHERE,
  '',
  'Sending adds to what the remote holds and takes nothing away. Of two records of the same',
  'level, the newer one counts, as in a clone.',
  '',
  'What is sent is what the files hold. A record: the commit, the level, the checks with their',
  'commands and results, the times, and the system and Node version it ran on. An approval:',
  'the commit, the branch, the time, and the signature. On a public repository, all of it is public.',
  '',
  'A policy that says "travel": true has the push hook, "approve" and "merge" do this by themselves.',
  '',
  'Options:',
  '  --remote <name>  The remote to send to. Default: "origin", or the only remote there is',
  '  -h, --help       Show this help',
  '',
  'Exit codes: 0 = the remote holds what this clone holds, 2 = the command could not run.',
].join('\n');

export const FETCH_USAGE = [
  'Usage: gotreceipts fetch [commit] [options]',
  '',
  'Gets the records and the approvals the remote holds for one commit, and puts them where',
  '"verify", the push hook and "merge" look. Without a commit, the one that is checked out.',
  '',
  ...WHERE,
  '',
  'Nothing is believed because it was fetched. A fetched record is judged like one made in this',
  'clone: by its commit, its level, its policy and its age. A fetched approval counts only when',
  'its signature is by a key the policy on the target branch lists. A file that is not exactly',
  'a record or an approval of this commit is not taken at all.',
  '',
  'Options:',
  '  --remote <name>  The remote to ask. Default: "origin", or the only remote there is',
  '  -h, --help       Show this help',
  '',
  'Exit codes: 0 = done, also when the remote holds nothing, 2 = the command could not run.',
].join('\n');

interface Asked {
  readonly root: string;
  readonly commit: string;
  readonly remote: string;
}

/** The part both commands share: the options, the commit and the remote. */
function ask(name: 'send' | 'fetch', usage: string, args: readonly string[], io: Io): Asked | ExitCode {
  const start = readOptions({ command: name, usage, values: ['remote'], positionals: true }, args, io);
  if (start.done) return start.code;
  const { options, positionals, cannotRun } = start;

  if (positionals.length > 1) return cannotRun('name one commit, not several');
  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');
  const asked = commitAskedFor(root, positionals[0]);
  if (!asked.ok) return cannotRun(asked.reason);
  const remote = pickRemote(root, options.remote);
  if (!remote.ok) return cannotRun(remote.reason);
  return { root, commit: asked.commit, remote: remote.name };
}

export async function sendCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const asked = ask('send', SEND_USAGE, args, io);
  if (typeof asked === 'number') return asked;
  const { root, commit, remote } = asked;
  const shortCommit = shortId(commit);

  io.out(`gotreceipts send: commit ${shortCommit}, to ${remote}`);
  const sent = sendReceipts(root, remote, commit, Date.now());
  if (sent.kind === 'error') {
    io.err(`gotreceipts send: CANNOT RUN: ${sent.reason}`);
    return EXIT.CANNOT_RUN;
  }
  if (sent.kind === 'nothing') {
    io.out(`  this clone holds no record and no approval of commit ${shortCommit}`);
    io.out('Nothing was sent.');
    return EXIT.PASS;
  }
  if (sent.kind === 'already') {
    io.out(`  ${remote} already holds what this clone holds: ${countOf(sent.held)}`);
    io.out('Nothing was sent.');
    return EXIT.PASS;
  }
  io.out(`  sent: ${countOf(sent.sent)}`);
  io.out(`  ${remote} now holds ${countOf(sent.held)} of this commit`);
  io.out(`Sent. Another clone gets them with: gotreceipts fetch ${shortCommit}`);
  return EXIT.PASS;
}

export async function fetchCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const asked = ask('fetch', FETCH_USAGE, args, io);
  if (typeof asked === 'number') return asked;
  const { root, commit, remote } = asked;
  const shortCommit = shortId(commit);

  io.out(`gotreceipts fetch: commit ${shortCommit}, from ${remote}`);
  const got = fetchReceipts(root, remote, commit, Date.now());
  if (got.kind === 'error') {
    io.err(`gotreceipts fetch: CANNOT RUN: ${got.reason}`);
    return EXIT.CANNOT_RUN;
  }
  if (got.kind === 'none' || got.held.length === 0) {
    io.out(`  ${remote} holds no record and no approval of commit ${shortCommit}`);
    io.out('Nothing was fetched.');
    return EXIT.PASS;
  }
  io.out(`  ${remote} holds ${countOf(got.held)} of this commit`);
  if (got.gained.length === 0) {
    io.out('  this clone already has them, or newer ones');
    io.out('Nothing was fetched.');
    return EXIT.PASS;
  }
  io.out(`  fetched: ${countOf(got.gained)}`);
  io.out(`Fetched. Whether they count is for the door to say: gotreceipts verify ${shortCommit} --for <branch>`);
  return EXIT.PASS;
}
