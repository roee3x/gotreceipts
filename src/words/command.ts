import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import { committableFiles, repoRoot } from '../git.ts';
import type { Io } from '../main.ts';
import { readOptions } from '../options.ts';
import { maskEntry, parseWordList, type WordEntry } from './list.ts';
import { findMatches, type WordMatch } from './match.ts';

export const WORDS_USAGE = [
  'Usage: gotreceipts words [options]',
  '',
  'Fails when a file git would commit, a file path, or a commit message contains',
  'an entry of your private word list.',
  '',
  'Options:',
  '  --list <file>      The private word list',
  '  --message <file>   Also check this file, for example a commit message',
  '  --show-words       Print the entries that were found (they are hidden by default)',
  '  -h, --help         Show this help',
  '',
  'The list is looked for in this order:',
  '  1. --list <file>',
  '  2. the environment variable GOTRECEIPTS_PRIVATE_WORDS',
  '  3. .gotreceipts/private-words.txt in your home folder',
  '',
  'The list has one entry per line. Empty lines and lines that start with # are ignored.',
  'Upper and lower case don\'t matter, and only whole words are matched.',
  '',
  'Exit codes: 0 = nothing found, 1 = an entry was found, 2 = the check could not run.',
].join('\n');

/** Where a match was found, for the report. */
interface Finding {
  readonly where: string;
  readonly match: WordMatch;
}

function resolveListPath(flag: string | undefined): string {
  if (flag !== undefined) return flag;
  const fromEnv = process.env['GOTRECEIPTS_PRIVATE_WORDS'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(homedir(), '.gotreceipts', 'private-words.txt');
}

/** Replaces every entry inside `text` with its hidden form, so a path can be shown safely. */
function hideEntries(text: string, entries: readonly WordEntry[]): string {
  let shown = text;
  for (const entry of entries) {
    const pattern = new RegExp(entry.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    shown = shown.replace(pattern, maskEntry(entry.text));
  }
  return shown;
}

export async function wordsCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  const start = readOptions({ command: 'words', usage: WORDS_USAGE, values: ['list', 'message'], switches: ['show-words'] }, args, io);
  if (start.done) return start.code;
  const { options, cannotRun } = start;

  // 1. The list. No list, or an empty one, means there is nothing to check with.
  const listPath = resolveListPath(options.list);
  if (!existsSync(listPath)) return cannotRun(`no word list at ${listPath}`);
  const entries = parseWordList(readFileSync(listPath, 'utf8'));
  if (entries.length === 0) return cannotRun('the word list has no entries');

  // 2. The files git would commit.
  const root = repoRoot(process.cwd());
  if (root === undefined) return cannotRun('this folder is not inside a git repository');
  const files = committableFiles(root);
  if (files === undefined) return cannotRun('git could not list the files');

  const showWords = options['show-words'] === true;
  const showPath = (path: string): string => (showWords ? path : hideEntries(path, entries));
  const findings: Finding[] = [];

  for (const file of files) {
    for (const match of findMatches(file, entries)) {
      findings.push({ where: `${showPath(file)} (the file path)`, match });
    }
    const fullPath = join(root, file);
    if (!existsSync(fullPath) || !lstatSync(fullPath).isFile()) continue;
    for (const match of findMatches(readFileSync(fullPath, 'utf8'), entries)) {
      findings.push({ where: `${showPath(file)}:${match.line}`, match });
    }
  }

  // 3. The extra file, usually a commit message.
  if (options.message !== undefined) {
    if (!existsSync(options.message)) return cannotRun(`no message file at ${options.message}`);
    for (const match of findMatches(readFileSync(options.message, 'utf8'), entries)) {
      findings.push({ where: `message:${match.line}`, match });
    }
  }

  // 4. The report. The last line is always the verdict.
  const checked = options.message === undefined ? `${files.length} files` : `${files.length} files and the message`;
  io.out(`Checked ${checked} against ${entries.length} entries.`);
  for (const finding of findings) {
    const entry = finding.match.entry;
    const shown = showWords ? entry.text : maskEntry(entry.text);
    io.out(`FOUND  ${finding.where}  entry on list line ${entry.line}: ${shown}`);
  }
  if (findings.length > 0) {
    io.out('VERDICT: FAIL');
    return EXIT.REFUSED;
  }
  io.out('VERDICT: PASS');
  return EXIT.PASS;
}
