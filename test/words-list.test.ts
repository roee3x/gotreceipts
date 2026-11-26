import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskEntry, parseWordList } from '../src/words/list.ts';

test('one entry per line, with the line it came from', () => {
  const entries = parseWordList('Zorblax\nAcme Rocket\n');
  assert.deepEqual(entries, [
    { text: 'Zorblax', line: 1 },
    { text: 'Acme Rocket', line: 2 },
  ]);
});

test('empty lines and # lines are ignored, and line numbers still count them', () => {
  const entries = parseWordList('# clients\n\nZorblax\n   \n# people\nQuillon\n');
  assert.deepEqual(entries, [
    { text: 'Zorblax', line: 3 },
    { text: 'Quillon', line: 6 },
  ]);
});

test('spaces around an entry are removed, spaces inside are kept', () => {
  assert.deepEqual(parseWordList('   Acme   Rocket  \n'), [{ text: 'Acme   Rocket', line: 1 }]);
});

test('Windows line endings and a byte-order mark are handled', () => {
  const entries = parseWordList('﻿Zorblax\r\nQuillon\r\n');
  assert.deepEqual(entries, [
    { text: 'Zorblax', line: 1 },
    { text: 'Quillon', line: 2 },
  ]);
});

test('a list with only comments has no entries', () => {
  assert.deepEqual(parseWordList('# nothing here\n\n'), []);
});

test('a hidden entry keeps its first character and its length, nothing more', () => {
  assert.equal(maskEntry('Zorblax'), 'Z******');
  assert.equal(maskEntry('ab'), 'a*');
  assert.equal(maskEntry('a'), '*');
});
