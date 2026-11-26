/** One entry of the private word list. */
export interface WordEntry {
  /** The entry as written, without the spaces around it. */
  readonly text: string;
  /** The line of the list file it came from, starting at 1. */
  readonly line: number;
}

/**
 * Reads a private word list.
 *
 * One entry per line. Empty lines and lines that start with # are ignored.
 * A byte-order mark at the start of the file is ignored too, because some editors add one.
 */
export function parseWordList(content: string): WordEntry[] {
  const entries: WordEntry[] = [];
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) return;
    entries.push({ text, line: index + 1 });
  });
  return entries;
}

/**
 * Hides an entry for display: the first character, then stars.
 * The check must not print the very words it exists to keep private.
 */
export function maskEntry(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= 1) return '*';
  return `${chars[0]}${'*'.repeat(chars.length - 1)}`;
}
