// A stand-in for GitHub's command line tool, "gh", for the tests of "gotreceipts merge".
//
// It knows one pull request, described in a small JSON file, and it keeps a list of everything
// it was asked. A merge request is carried out for real in the test's second repository, the
// way GitHub would: a merge commit on the target branch. So the tests can check both what the
// tool asked for and what came of it.
//
// The file it reads is named by the environment variable FAKE_GH_STATE.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

interface State {
  /** The folder of the repository that plays GitHub. */
  remote: string;
  /** Every call is written here, one JSON list of arguments per line. */
  log: string;
  pr: {
    number: number;
    state: string;
    isDraft: boolean;
    headRefName: string;
    baseRefName: string;
    url: string;
    mergeCommit?: { oid: string };
  };
  /** When set, "pr view" fails with this message. */
  failView?: string;
  /** When set, "pr merge" is refused with this message. */
  refuseMerge?: string;
  /** When set, the target branch jumps to this commit just before the merge, as if someone else got in first. */
  moveBaseTo?: string;
}

const statePath = process.env['FAKE_GH_STATE'] ?? '';
const state = JSON.parse(readFileSync(statePath, 'utf8')) as State;
const args = process.argv.slice(2);
appendFileSync(state.log, `${JSON.stringify(args)}\n`);

function gitInRemote(...gitArgs: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Fake GitHub', '-c', 'user.email=fake@example.com', ...gitArgs], {
    cwd: state.remote,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`fake gh: git ${gitArgs.join(' ')} failed: ${result.stderr}`);
    process.exit(70);
  }
  return result.stdout.trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const headNow = (): string => gitInRemote('rev-parse', `refs/heads/${state.pr.headRefName}`);

if (args[0] === 'pr' && args[1] === 'view') {
  if (state.failView !== undefined) fail(state.failView);
  if (args[2] !== String(state.pr.number)) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.`);
  const all: Record<string, unknown> = { ...state.pr, headRefOid: headNow(), mergeCommit: state.pr.mergeCommit ?? null };
  const wanted = (valueAfter('--json') ?? '').split(',');
  console.log(JSON.stringify(Object.fromEntries(wanted.map((name) => [name, all[name]]))));
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
  if (state.refuseMerge !== undefined) fail(state.refuseMerge);
  const head = headNow();
  if (valueAfter('--match-head-commit') !== head) {
    fail('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)');
  }
  const baseRef = `refs/heads/${state.pr.baseRefName}`;
  if (state.moveBaseTo !== undefined) gitInRemote('update-ref', baseRef, state.moveBaseTo);
  const base = gitInRemote('rev-parse', baseRef);
  const tree = gitInRemote('merge-tree', '--write-tree', '--no-messages', base, head).split('\n')[0] ?? '';
  const subject = valueAfter('--subject') ?? `Merge pull request #${state.pr.number}`;
  const commit = gitInRemote('commit-tree', tree, '-p', base, '-p', head, '-m', subject);
  gitInRemote('update-ref', baseRef, commit);

  state.pr.state = 'MERGED';
  state.pr.mergeCommit = { oid: commit };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`Merged pull request #${state.pr.number}`);
  process.exit(0);
}

fail(`fake gh: this stand-in does not know: gh ${args.join(' ')}`);
