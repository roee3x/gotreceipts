import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entriesOf, type Step } from '../src/audit/entries.ts';

/** A commit on the branch's own line. The names stand in for commit ids. */
function step(commit: string, ...parents: string[]): Step {
  return { commit, parents };
}

test('a merge commit is one entry, and what entered is the commit that was merged in', () => {
  assert.deepEqual(entriesOf([step('m2', 'm1', 'x2'), step('m1', 'base', 'x1')]), [
    { kind: 'merge', on: 'm2', before: 'm1', entered: 'x2', commits: 1 },
    { kind: 'merge', on: 'm1', before: 'base', entered: 'x1', commits: 1 },
  ]);
});

test('commits pushed straight onto the branch count as one push, and what entered is the newest of them', () => {
  assert.deepEqual(entriesOf([step('c3', 'c2'), step('c2', 'c1'), step('c1', 'base')]), [
    { kind: 'push', on: 'c3', before: 'base', entered: 'c3', commits: 3 },
  ]);
});

test('a merge between two pushes keeps them apart', () => {
  assert.deepEqual(entriesOf([step('c2', 'm'), step('m', 'c1', 'x'), step('c1', 'base')]), [
    { kind: 'push', on: 'c2', before: 'm', entered: 'c2', commits: 1 },
    { kind: 'merge', on: 'm', before: 'c1', entered: 'x', commits: 1 },
    { kind: 'push', on: 'c1', before: 'base', entered: 'c1', commits: 1 },
  ]);
});

test('a push that reaches the first commit of the history has nothing before it', () => {
  assert.deepEqual(entriesOf([step('c2', 'root'), step('root')]), [{ kind: 'push', on: 'c2', before: undefined, entered: 'c2', commits: 2 }]);
});

test('a merge of more than two lines of history is its own kind: nobody can say which commit entered', () => {
  assert.deepEqual(entriesOf([step('m', 'base', 'x', 'y')]), [{ kind: 'many-parents', on: 'm', before: 'base', entered: 'm', commits: 1 }]);
});

test('nothing on the line is no entry', () => {
  assert.deepEqual(entriesOf([]), []);
});
