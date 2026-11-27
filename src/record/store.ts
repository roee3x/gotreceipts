import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { storeFolder, storeLabel, writeWhole } from '../store.ts';
import { parseRecord, type GateRecord } from './record.ts';

/** The folder that holds the records: "records" in the tool's folder inside .git. One folder per commit in it. */
function recordsFolder(root: string): string | undefined {
  const store = storeFolder(root);
  return store === undefined ? undefined : join(store, 'records');
}

/** How a record's place is shown to the user: without the machine's folders in front of it. */
export function recordLabel(record: Pick<GateRecord, 'commit' | 'level'>): string {
  return storeLabel('records', record.commit, `${record.level}.json`);
}

/**
 * Writes a record: one file per commit and level. A newer run at the same level replaces the older one.
 * Returns false when the record could not be written.
 */
export function writeRecord(root: string, record: GateRecord): boolean {
  const folder = recordsFolder(root);
  if (folder === undefined) return false;
  try {
    const commitFolder = join(folder, record.commit);
    mkdirSync(commitFolder, { recursive: true });
    writeWhole(join(commitFolder, `${record.level}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface StoredRecords {
  readonly records: readonly GateRecord[];
  /** Files in the commit's folder that are not valid records, with the reason. */
  readonly unreadable: readonly string[];
}

/** Reads every record of one commit. A file that is not a valid record is reported, never used. */
export function readRecords(root: string, commit: string): StoredRecords {
  const folder = recordsFolder(root);
  if (folder === undefined) return { records: [], unreadable: [] };
  const commitFolder = join(folder, commit);
  if (!existsSync(commitFolder)) return { records: [], unreadable: [] };

  const records: GateRecord[] = [];
  const unreadable: string[] = [];
  for (const name of readdirSync(commitFolder).sort()) {
    if (!name.endsWith('.json')) continue;
    let text: string;
    try {
      text = readFileSync(join(commitFolder, name), 'utf8');
    } catch {
      unreadable.push(`${name}: could not be read`);
      continue;
    }
    const parsed = parseRecord(text);
    if (!parsed.ok) {
      unreadable.push(`${name}: ${parsed.error}`);
    } else if (parsed.record.commit !== commit) {
      unreadable.push(`${name}: it is a record of another commit`);
    } else if (`${parsed.record.level}.json` !== name) {
      unreadable.push(`${name}: it is a record of another level`);
    } else {
      records.push(parsed.record);
    }
  }
  return { records, unreadable };
}
