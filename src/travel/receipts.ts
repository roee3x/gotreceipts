import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseApproval } from '../approval/statement.ts';
import { parseRecord } from '../record/record.ts';
import { recordsFolder } from '../record/store.ts';

/**
 * Records and approvals that travel.
 *
 * In a clone they are files inside the .git folder. To reach another clone, or CI, they are
 * put into git itself: one small commit per checked commit, under a name of its own on the
 * remote, "refs/gotreceipts/<commit>". That is not a branch and not a tag. A normal clone or
 * fetch does not download it, and GitHub does not show it. Whoever wants it asks for it by name.
 *
 * The small commit holds the same files, under the same names:
 *
 *   records/<level>.json
 *   approvals/<branch>.json   and   approvals/<branch>.json.sig
 *
 * What travelled is still a plain file. Nothing here decides whether it counts. That stays with
 * the doors, which judge a fetched record exactly like a local one, and which believe an
 * approval only for its signature.
 */

export const RECEIPTS_PREFIX = 'refs/gotreceipts/';

/** The name, on the remote, under which the records and approvals of one commit are kept. */
export function receiptsRef(commit: string): string {
  return `${RECEIPTS_PREFIX}${commit}`;
}

/** One record, or one approval with its signature. */
export interface Receipt {
  /** "records/G2" or "approvals/main". The same in every clone, so two copies of one thing can be told to be that. */
  readonly key: string;
  readonly kind: 'record' | 'approval';
  /** When it was made, in milliseconds. A newer one replaces an older one of the same key. */
  readonly time: number;
  /** Its files, as path and content. One for a record, two for an approval. */
  readonly files: ReadonlyMap<string, Buffer>;
}

/** The largest file that is accepted from a remote. A record is a few kilobytes. */
const MAX_BYTES = 1024 * 1024;
/** Two machines never agree on the time to the second. The same allowance the doors give. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const RECORD_PATH = /^records\/([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;
/** The branch part is a branch name as a file name: letters, digits, and what "encodeURIComponent" leaves or makes. */
const APPROVAL_PATH = /^approvals\/([A-Za-z0-9._~!*'()%-]+)\.json$/;

/**
 * Sorts loose files into receipts. A file that is not exactly what it should be is left out:
 * a record that does not read, or is of another commit or level; an approval without its
 * signature, or of another commit or branch; anything under another name.
 *
 * This is the one place where files from outside are looked at before they are kept, so it is
 * strict. The names are checked against a fixed pattern, never used as given.
 */
export function sortIntoReceipts(commit: string, files: ReadonlyMap<string, Buffer>): Receipt[] {
  const receipts: Receipt[] = [];
  for (const [path, content] of files) {
    if (content.length > MAX_BYTES) continue;

    const level = RECORD_PATH.exec(path)?.[1];
    if (level !== undefined) {
      const parsed = parseRecord(content.toString('utf8'));
      if (!parsed.ok || parsed.record.commit !== commit || parsed.record.level !== level) continue;
      const time = Date.parse(parsed.record.finishedAt);
      if (Number.isNaN(time)) continue;
      receipts.push({ key: `records/${level}`, kind: 'record', time, files: new Map([[path, content]]) });
      continue;
    }

    const name = APPROVAL_PATH.exec(path)?.[1];
    if (name !== undefined) {
      const signature = files.get(`${path}.sig`);
      if (signature === undefined || signature.length > MAX_BYTES) continue;
      const parsed = parseApproval(content.toString('utf8'));
      if (!parsed.ok || parsed.approval.commit !== commit || encodeURIComponent(parsed.approval.branch) !== name) continue;
      const time = Date.parse(parsed.approval.approvedAt);
      if (Number.isNaN(time)) continue;
      receipts.push({
        key: `approvals/${name}`,
        kind: 'approval',
        time,
        files: new Map([
          [path, content],
          [`${path}.sig`, signature],
        ]),
      });
    }
  }
  return receipts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Leaves out what is dated in the future. No door would count it, and because the newer of two
 * always replaces the older, one such file would stand in the way of every honest one after it.
 */
export function notFromTheFuture(receipts: readonly Receipt[], now: number): Receipt[] {
  return receipts.filter((receipt) => receipt.time <= now + CLOCK_TOLERANCE_MS);
}

/** The folder inside .git that holds the "records" and the "approvals" folders. */
function storeFolder(root: string): string | undefined {
  const records = recordsFolder(root);
  return records === undefined ? undefined : dirname(records);
}

/** The records and approvals this clone holds for one commit. */
export function localReceipts(root: string, commit: string): Receipt[] {
  const store = storeFolder(root);
  if (store === undefined) return [];
  const files = new Map<string, Buffer>();
  for (const kind of ['records', 'approvals']) {
    const folder = join(store, kind, commit);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      try {
        files.set(`${kind}/${name}`, readFileSync(join(folder, name)));
      } catch {
        // A file that cannot be read is not sent.
      }
    }
  }
  return sortIntoReceipts(commit, files);
}

/**
 * Puts receipts into this clone's store. Each file is written under another name first and
 * then renamed, an approval's signature last, so nothing half-written is ever read.
 * Returns false when one could not be written.
 */
export function keepReceipts(root: string, commit: string, receipts: readonly Receipt[]): boolean {
  const store = storeFolder(root);
  if (store === undefined) return false;
  try {
    for (const receipt of receipts) {
      // The statement before its signature, as when an approval is first signed.
      for (const [path, content] of [...receipt.files].sort(([a], [b]) => a.length - b.length)) {
        const [kind = '', name = ''] = path.split('/');
        const target = join(store, kind, commit, name);
        mkdirSync(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(temporary, content);
        renameSync(temporary, target);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface Merged {
  /** Every receipt of both sides, and of two with the same key the newer one. */
  readonly all: readonly Receipt[];
  /** The ones of `theirs` that `ours` lacked, or held an older copy of. */
  readonly gained: readonly Receipt[];
}

/**
 * Puts two sets of receipts together. Of two with the same key, the newer one stays, as when a
 * newer gate run replaces an older one in a clone. So a newer failed run is never hidden behind
 * an older pass, on either side.
 */
export function mergeReceipts(ours: readonly Receipt[], theirs: readonly Receipt[]): Merged {
  const all = new Map(ours.map((receipt) => [receipt.key, receipt]));
  const gained: Receipt[] = [];
  for (const receipt of theirs) {
    const mine = all.get(receipt.key);
    if (mine === undefined || receipt.time > mine.time) {
      all.set(receipt.key, receipt);
      gained.push(receipt);
    }
  }
  return { all: [...all.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), gained };
}

/** True when two receipts hold the same files with the same content. */
function sameReceipt(a: Receipt, b: Receipt): boolean {
  if (a.files.size !== b.files.size) return false;
  for (const [path, content] of a.files) {
    const other = b.files.get(path);
    if (other === undefined || !other.equals(content)) return false;
  }
  return true;
}

/** True when both sets hold the same receipts. */
export function sameReceipts(a: readonly Receipt[], b: readonly Receipt[]): boolean {
  return a.length === b.length && a.every((receipt) => b.some((other) => other.key === receipt.key && sameReceipt(receipt, other)));
}

/** "2 records and 1 approval", "1 record", "nothing". */
export function countOf(receipts: readonly Receipt[]): string {
  const records = receipts.filter((receipt) => receipt.kind === 'record').length;
  const approvals = receipts.length - records;
  const parts = [
    ...(records > 0 ? [`${records} ${records === 1 ? 'record' : 'records'}`] : []),
    ...(approvals > 0 ? [`${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`] : []),
  ];
  return parts.length === 0 ? 'nothing' : parts.join(' and ');
}

// --- receipts as a git commit ---

interface RawGit {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Runs git with bytes in and bytes out. A record is text, but a signature is checked byte for byte. */
function gitRaw(args: readonly string[], cwd: string, input?: Buffer, env?: NodeJS.ProcessEnv): RawGit {
  const result = spawnSync('git', args, { cwd, input, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error !== undefined) return { ok: false, stdout: Buffer.alloc(0), stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.toString('utf8') };
}

/** The files a receipts commit holds, as path and content. Undefined when git could not read it. */
export function filesOfCommit(root: string, receiptsCommit: string): Map<string, Buffer> | undefined {
  // Each entry is "<mode> <type> <id> <size>", a tab, the path, and a zero byte.
  const listed = gitRaw(['ls-tree', '-r', '-l', '-z', receiptsCommit], root);
  if (!listed.ok) return undefined;
  const files = new Map<string, Buffer>();
  for (const entry of listed.stdout.toString('utf8').split('\0')) {
    const [about = '', path = ''] = entry.split('\t');
    const [mode, type, id, size] = about.trim().split(/\s+/);
    // Only plain files, of a sane size, and only under the two known folders. Everything else is not looked at.
    if (mode !== '100644' || type !== 'blob' || id === undefined || Number(size) > MAX_BYTES) continue;
    if (!RECORD_PATH.test(path) && !APPROVAL_PATH.test(path.replace(/\.sig$/, ''))) continue;
    const content = gitRaw(['cat-file', 'blob', id], root);
    if (content.ok) files.set(path, content.stdout);
  }
  return files;
}

/**
 * Writes receipts into git as one commit, with `parent` before it, and returns its id.
 * Nothing is checked out and no branch moves: the objects are written straight into the
 * repository.
 */
export function writeCommit(root: string, commit: string, receipts: readonly Receipt[], parent: string | undefined): string | undefined {
  const folders = new Map<string, string[]>();
  for (const receipt of receipts) {
    for (const [path, content] of receipt.files) {
      const blob = gitRaw(['hash-object', '-w', '--stdin'], root, content);
      if (!blob.ok) return undefined;
      const [folder = '', name = ''] = path.split('/');
      folders.set(folder, [...(folders.get(folder) ?? []), `100644 blob ${blob.stdout.toString('utf8').trim()}\t${name}\n`]);
    }
  }

  const top: string[] = [];
  for (const [folder, lines] of [...folders].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const tree = gitRaw(['mktree'], root, Buffer.from(lines.sort().join('')));
    if (!tree.ok) return undefined;
    top.push(`040000 tree ${tree.stdout.toString('utf8').trim()}\t${folder}\n`);
  }
  const tree = gitRaw(['mktree'], root, Buffer.from(top.join('')));
  if (!tree.ok) return undefined;

  // The commit is made in the tool's own name, on every machine. It is not anyone's work, and
  // this way it carries no person's name or address to the remote. It also works on a machine
  // where git has no name set, such as one in CI.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'gotreceipts',
    GIT_AUTHOR_EMAIL: 'receipts@gotreceipts.invalid',
    GIT_COMMITTER_NAME: 'gotreceipts',
    GIT_COMMITTER_EMAIL: 'receipts@gotreceipts.invalid',
  };
  const made = gitRaw(
    ['commit-tree', tree.stdout.toString('utf8').trim(), ...(parent === undefined ? [] : ['-p', parent]), '-m', `gotreceipts: records and approvals of ${commit}`],
    root,
    undefined,
    env,
  );
  return made.ok ? made.stdout.toString('utf8').trim() : undefined;
}
