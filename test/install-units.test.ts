// The text of the hook file, and the small questions asked about it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cliOfHook, hookScript, isManagedHook, keptName, looksTemporary } from '../src/install/hook-script.ts';

const LAUNCHER = { node: '/usr/bin/node', cli: '/opt/tool/dist/cli.js' };

test('the hook file says it was written by this tool, and a file of another origin does not', () => {
  assert.equal(isManagedHook(hookScript('pre-push', LAUNCHER)), true);
  assert.equal(isManagedHook('#!/bin/sh\nnpm test\n'), false);
  assert.equal(isManagedHook(''), false);
});

test('the hook file is a shell script with plain line endings', () => {
  const script = hookScript('pre-push', LAUNCHER);
  assert.ok(script.startsWith('#!/bin/sh\n'));
  assert.equal(script.includes('\r'), false);
  assert.ok(script.endsWith('\n'));
});

test('the hook calls the tool with the name of the hook, and hands git\'s arguments on', () => {
  const script = hookScript('pre-push', LAUNCHER);
  assert.match(script, /"\$node" "\$cli" hook pre-push "\$@"\n$/);
});

test('an older hook is kept under a second name, and the hook file runs it first', () => {
  assert.equal(keptName('pre-push'), 'pre-push.local');
  const script = hookScript('pre-push', LAUNCHER);
  const older = script.indexOf('pre-push.local" "$@"');
  const own = script.indexOf('hook pre-push "$@"');
  assert.ok(older !== -1 && own !== -1 && older < own);
});

test('the place of the tool can be read back from the hook file', () => {
  assert.equal(cliOfHook(hookScript('pre-push', LAUNCHER)), '/opt/tool/dist/cli.js');
  assert.equal(cliOfHook('#!/bin/sh\nnpm test\n'), undefined);
});

test('a Windows path is written with forward slashes, which the shell understands', () => {
  const script = hookScript('pre-push', { node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Tools\\got receipts\\dist\\cli.js' });
  assert.match(script, /^node='C:\/Program Files\/nodejs\/node\.exe'$/m);
  assert.equal(cliOfHook(script), 'C:/Tools/got receipts/dist/cli.js');
});

test('a path with a quote in it survives being written and read back', () => {
  const script = hookScript('pre-push', { node: '/usr/bin/node', cli: "/home/o'neil/tool/cli.js" });
  assert.equal(cliOfHook(script), "/home/o'neil/tool/cli.js");
});

test('a tool that runs from the folder npx downloads into is recognised as temporary', () => {
  assert.equal(looksTemporary('C:\\Users\\someone\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\gotreceipts\\dist\\cli.js'), true);
  assert.equal(looksTemporary('/home/someone/.npm/_npx/1a2b3c/node_modules/gotreceipts/dist/cli.js'), true);
  assert.equal(looksTemporary('/home/someone/project/node_modules/gotreceipts/dist/cli.js'), false);
  assert.equal(looksTemporary('C:\\Tools\\gotreceipts\\dist\\cli.js'), false);
});
