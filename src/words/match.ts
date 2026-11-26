import type { WordEntry } from './list.ts';

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

function isLetterOrDigit(char: string | undefined): boolean {
  return char !== undefined && LETTER_OR_DIGIT.test(char);
}

/** The whole character that ends just before `index`, or undefined at the start of the text. */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff;
  if (isLowSurrogate && index >= 2) return text.slice(index - 2, index);
  return text[index - 1];
}

/** The whole character that starts at `index`, or undefined at the end of the text. */
function charAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

/** An entry made ready for searching. */
interface PreparedEntry {
  readonly entry: WordEntry;
  readonly needle: string;
  readonly needsLeftEdge: boolean;
  readonly needsRightEdge: boolean;
}

function prepare(entry: WordEntry): PreparedEntry {
  const needle = entry.text.toLowerCase();
  const chars = Array.from(needle);
  return {
    entry,
    needle,
    needsLeftEdge: isLetterOrDigit(chars[0]),
    needsRightEdge: isLetterOrDigit(chars[chars.length - 1]),
  };
}

/**
 * True when `line` contains the entry as a whole word.
 *
 * Upper and lower case don't matter. "Whole word" means the entry is not glued to a
 * letter or a digit on either side: "acme" is found in "the Acme app" and in "acme-app",
 * but not inside "acmeville".
 *
 * The edge rule applies only where the entry itself starts or ends with a letter or a digit.
 * An entry like "com.acme." therefore still matches in front of the next name.
 *
 * `lowerLine` must already be lower case.
 */
function lineContains(lowerLine: string, prepared: PreparedEntry): boolean {
  const { needle, needsLeftEdge, needsRightEdge } = prepared;
  if (needle === '') return false;

  let start = lowerLine.indexOf(needle);
  while (start !== -1) {
    const end = start + needle.length;
    const leftOk = !needsLeftEdge || !isLetterOrDigit(charBefore(lowerLine, start));
    const rightOk = !needsRightEdge || !isLetterOrDigit(charAt(lowerLine, end));
    if (leftOk && rightOk) return true;
    start = lowerLine.indexOf(needle, start + 1);
  }
  return false;
}

/** One place where a private entry was found. */
export interface WordMatch {
  readonly entry: WordEntry;
  /** The line of the searched text, starting at 1. */
  readonly line: number;
}

/** Finds every private entry in a text, line by line. */
export function findMatches(text: string, entries: readonly WordEntry[]): WordMatch[] {
  const prepared = entries.map(prepare);
  const matches: WordMatch[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lowerLine = line.toLowerCase();
    for (const candidate of prepared) {
      if (lineContains(lowerLine, candidate)) {
        matches.push({ entry: candidate.entry, line: index + 1 });
      }
    }
  });
  return matches;
}
