import { gitBytes } from '../git.ts';
import { isReceiptPath, MAX_BYTES, type Receipt } from './receipt.ts';

/**
 * Records and approvals as a commit in git: the form in which they travel.
 *
 * Nothing is checked out and no branch moves. The files, the folders and the commit are
 * written straight into the repository as git objects, and read back the same way.
 */

/** What git prints for one made object: its id. Undefined when git failed. */
function madeBy(root: string, args: readonly string[], input?: Buffer, env?: NodeJS.ProcessEnv): string | undefined {
  const made = gitBytes(args, root, input, env);
  return made.ok ? made.stdout.toString('utf8').trim() : undefined;
}

/** Writes one folder as a git object, from its lines, and returns its id. */
function folderOf(root: string, lines: readonly string[]): string | undefined {
  return madeBy(root, ['mktree'], Buffer.from(lines.join('')));
}

/** The files a receipts commit holds, as path and content. Undefined when git could not read it. */
export function filesOfCommit(root: string, receiptsCommit: string): Map<string, Buffer> | undefined {
  // Each entry is "<mode> <type> <id> <size>", a tab, the path, and a zero byte.
  const listed = gitBytes(['ls-tree', '-r', '-l', '-z', receiptsCommit], root);
  if (!listed.ok) return undefined;
  const files = new Map<string, Buffer>();
  for (const entry of listed.stdout.toString('utf8').split('\0')) {
    const [about = '', path = ''] = entry.split('\t');
    const [mode, type, id, size] = about.trim().split(/\s+/);
    // Only plain files, of a sane size, and only under the two known folders. Everything else is not looked at.
    if (mode !== '100644' || type !== 'blob' || id === undefined || Number(size) > MAX_BYTES) continue;
    if (!isReceiptPath(path)) continue;
    const content = gitBytes(['cat-file', 'blob', id], root);
    if (content.ok) files.set(path, content.stdout);
  }
  return files;
}

/**
 * The commit is made in the tool's own name, on every machine. It is not anyone's work, and
 * this way it carries no person's name or address to the remote. It also works on a machine
 * where git has no name set, such as one in CI.
 */
const WRITTEN_BY = {
  GIT_AUTHOR_NAME: 'gotreceipts',
  GIT_AUTHOR_EMAIL: 'receipts@gotreceipts.invalid',
  GIT_COMMITTER_NAME: 'gotreceipts',
  GIT_COMMITTER_EMAIL: 'receipts@gotreceipts.invalid',
};

/**
 * Writes receipts into git as one commit, with `parent` before it, and returns its id.
 * Undefined when git could not write one of the objects.
 */
export function writeCommit(root: string, commit: string, receipts: readonly Receipt[], parent: string | undefined): string | undefined {
  // 1. Every file, and for each of the two folders the lines that list its files.
  const folders = new Map<string, string[]>();
  for (const receipt of receipts) {
    for (const [path, content] of receipt.files) {
      const file = madeBy(root, ['hash-object', '-w', '--stdin'], content);
      if (file === undefined) return undefined;
      const [folder = '', name = ''] = path.split('/');
      folders.set(folder, [...(folders.get(folder) ?? []), `100644 blob ${file}\t${name}\n`]);
    }
  }

  // 2. The folders, in a fixed order, and the folder that holds them.
  const top: string[] = [];
  for (const [folder, lines] of [...folders].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const made = folderOf(root, lines.sort());
    if (made === undefined) return undefined;
    top.push(`040000 tree ${made}\t${folder}\n`);
  }
  const tree = folderOf(root, top);
  if (tree === undefined) return undefined;

  // 3. The commit.
  const before = parent === undefined ? [] : ['-p', parent];
  const message = `gotreceipts: records and approvals of ${commit}`;
  return madeBy(root, ['commit-tree', tree, ...before, '-m', message], undefined, { ...process.env, ...WRITTEN_BY });
}
