import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WordEntry } from '../src/words/list.ts';
import { findMatches } from '../src/words/match.ts';

/** Builds a list from plain strings; the list line is the position in the array. */
function list(...texts: string[]): WordEntry[] {
  return texts.map((text, index) => ({ text, line: index + 1 }));
}

/** True when the text contains the single entry. */
function found(text: string, entry: string): boolean {
  return findMatches(text, list(entry)).length > 0;
}

test('an entry is found whatever its upper or lower case', () => {
  assert.ok(found('the Zorblax app', 'zorblax'));
  assert.ok(found('the ZORBLAX app', 'Zorblax'));
  assert.ok(found('the zorblax app', 'ZORBLAX'));
});

test('an entry is found at the very start and the very end of the text', () => {
  assert.ok(found('Zorblax is here', 'Zorblax'));
  assert.ok(found('here is Zorblax', 'Zorblax'));
  assert.ok(found('Zorblax', 'Zorblax'));
});

test('an entry is not found inside a longer word', () => {
  // The real case behind this rule: a short name sitting inside an everyday word.
  assert.equal(found('fitness for a particular purpose', 'art'), false);
  assert.equal(found('the Zorblaxian empire', 'Zorblax'), false);
  assert.equal(found('megazorblax', 'Zorblax'), false);
  assert.equal(found('zorblax2', 'Zorblax'), false);
});

test('punctuation, hyphens and underscores count as word edges', () => {
  assert.ok(found('zorblax-app', 'Zorblax'));
  assert.ok(found('zorblax_app', 'Zorblax'));
  assert.ok(found('see (Zorblax).', 'Zorblax'));
  assert.ok(found('path/to/zorblax/file', 'Zorblax'));
  assert.ok(found('someone@zorblax.example', 'Zorblax'));
});

test('an entry that ends with punctuation matches in front of the next name', () => {
  assert.ok(found('the id is com.zorblax.rocket', 'com.zorblax.'));
  assert.equal(found('the id is xcom.zorblax.rocket', 'com.zorblax.'), false);
});

test('an entry with spaces is matched as a phrase', () => {
  assert.ok(found('made for Acme Rocket today', 'Acme Rocket'));
  assert.equal(found('made for Acme Rocketry today', 'Acme Rocket'), false);
});

test('a phone number is matched only as a whole number', () => {
  assert.ok(found('call 5550100 now', '5550100'));
  assert.equal(found('call +15550100 now', '5550100'), false);
  assert.ok(found('call +15550100 now', '15550100'));
});

test('entries in other alphabets follow the same whole-word rule', () => {
  assert.ok(found('שלום זורבלקס שלום', 'זורבלקס'));
  assert.equal(found('שלום זורבלקסים שלום', 'זורבלקס'), false);
});

test('a path entry with backslashes is matched literally', () => {
  assert.ok(found('C:\\Users\\Someone\\Documents', 'Users\\Someone'));
  assert.equal(found('C:\\Users\\Someone2\\Documents', 'Users\\Someone'), false);
});

test('each match reports the entry and the line of the text', () => {
  const entries = list('Zorblax', 'Quillon');
  const matches = findMatches('first line\nZorblax here\nnothing\nQuillon and zorblax', entries);
  assert.deepEqual(
    matches.map((match) => [match.entry.text, match.line]),
    [
      ['Zorblax', 2],
      ['Zorblax', 4],
      ['Quillon', 4],
    ],
  );
});

test('an entry on a line is reported once, however often it appears there', () => {
  assert.equal(findMatches('Zorblax Zorblax Zorblax', list('Zorblax')).length, 1);
});

test('clean text has no matches', () => {
  assert.deepEqual(findMatches('nothing private here', list('Zorblax', 'Quillon')), []);
});
