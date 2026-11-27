import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { storeFolder, writeWhole } from '../store.ts';
import { sortIntoReceipts, type Receipt } from './receipt.ts';

/**
 * Records and approvals in a clone: the files inside its .git folder, where "gate" writes a
 * record, "approve" keeps an approval, and every door looks.
 *
 * A receipt's path is the same here as in the commit that travels, with the commit's own
 * folder in between: "records/G2.json" is the file records/<commit>/G2.json of the store.
 */

/** The folders of the store that hold what travels. */
const KINDS = ['records', 'approvals'];

/** The records and approvals this clone holds for one commit. */
export function localReceipts(root: string, commit: string): Receipt[] {
  const store = storeFolder(root);
  if (store === undefined) return [];
  const files = new Map<string, Buffer>();
  for (const kind of KINDS) {
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
      // The statement before its signature, as when an approval is first signed. The
      // signature's path is the statement's path with an ending, so it is the longer one.
      const statementFirst = [...receipt.files].sort(([a], [b]) => a.length - b.length);
      for (const [path, content] of statementFirst) {
        const [kind = '', name = ''] = path.split('/');
        const target = join(store, kind, commit, name);
        mkdirSync(dirname(target), { recursive: true });
        writeWhole(target, content);
      }
    }
    return true;
  } catch {
    return false;
  }
}
