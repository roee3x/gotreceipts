import { parseApproval } from '../approval/statement.ts';
import { isInTheFuture } from '../clock.ts';
import { parseRecord } from '../record/record.ts';

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
 *
 * The folder has four files:
 *
 *   receipt.ts   What one record or approval is, and which files are accepted as one. This file.
 *   local.ts     Reading and writing them in a clone's .git folder.
 *   objects.ts   Reading and writing them as a commit in git.
 *   remote.ts    Asking a remote for them, sending and fetching.
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

/** The order receipts are always kept in, so that the same set gives the same commit in every clone. */
function byKey(a: Receipt, b: Receipt): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// --- which files are accepted ---

/** The largest file that is accepted from a remote. A record is a few kilobytes. */
export const MAX_BYTES = 1024 * 1024;
const RECORD_PATH = /^records\/([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;
/** The branch part is a branch name as a file name: letters, digits, and what "encodeURIComponent" leaves or makes. */
const APPROVAL_PATH = /^approvals\/([A-Za-z0-9._~!*'()%-]+)\.json$/;
const SIGNATURE_ENDING = '.sig';

/** True for the path of a record, of an approval, or of an approval's signature. Any other file is not looked at. */
export function isReceiptPath(path: string): boolean {
  return RECORD_PATH.test(path) || APPROVAL_PATH.test(path.endsWith(SIGNATURE_ENDING) ? path.slice(0, -SIGNATURE_ENDING.length) : path);
}

/** A file as a record of `commit` at `level`, or undefined when it is not exactly that. */
function asRecord(commit: string, level: string, path: string, content: Buffer): Receipt | undefined {
  const parsed = parseRecord(content.toString('utf8'));
  if (!parsed.ok || parsed.record.commit !== commit || parsed.record.level !== level) return undefined;
  const time = Date.parse(parsed.record.finishedAt);
  if (Number.isNaN(time)) return undefined;
  return { key: `records/${level}`, kind: 'record', time, files: new Map([[path, content]]) };
}

/** A file and its signature as an approval of `commit` for the branch its name says, or undefined when it is not exactly that. */
function asApproval(commit: string, branchName: string, path: string, content: Buffer, signature: Buffer | undefined): Receipt | undefined {
  if (signature === undefined || signature.length > MAX_BYTES) return undefined;
  const parsed = parseApproval(content.toString('utf8'));
  if (!parsed.ok || parsed.approval.commit !== commit || encodeURIComponent(parsed.approval.branch) !== branchName) return undefined;
  const time = Date.parse(parsed.approval.approvedAt);
  if (Number.isNaN(time)) return undefined;
  return {
    key: `approvals/${branchName}`,
    kind: 'approval',
    time,
    files: new Map([
      [path, content],
      [`${path}${SIGNATURE_ENDING}`, signature],
    ]),
  };
}

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
    const branchName = APPROVAL_PATH.exec(path)?.[1];
    const receipt =
      level !== undefined
        ? asRecord(commit, level, path, content)
        : branchName !== undefined
          ? asApproval(commit, branchName, path, content, files.get(`${path}${SIGNATURE_ENDING}`))
          : undefined;
    if (receipt !== undefined) receipts.push(receipt);
  }
  return receipts.sort(byKey);
}

/**
 * Leaves out what is dated in the future. No door would count it, and because the newer of two
 * always replaces the older, one such file would stand in the way of every honest one after it.
 */
export function notFromTheFuture(receipts: readonly Receipt[], now: number): Receipt[] {
  return receipts.filter((receipt) => !isInTheFuture(receipt.time, now));
}

// --- two sets of them ---

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
  return { all: [...all.values()].sort(byKey), gained };
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
