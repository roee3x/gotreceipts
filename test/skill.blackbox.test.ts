// Outside-in tests for the skill: the text that tells the agent how to work behind the gate.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cliPath, gitIn, looseFiles, noPersonalGitSettings, runCli, tempRepo, writeIn } from './helpers/temp-repo.ts';

const POLICY = {
  schema: 1,
  levels: [{ name: 'G0', checks: [{ name: 'build', run: 'node checks/pass.js' }] }],
  tiers: [{ branch: 'feature/*', level: 'G0' }],
};

const SKILL = '.claude/skills/gotreceipts/SKILL.md';
const MARKER = 'gotreceipts:managed-skill';
const START_LINE = `start it as: \`node "${cliPath.replace(/\\/g, '/')}"\``;

const sourceFolder = fileURLToPath(new URL('../src', import.meta.url));
const shipped = readFileSync(fileURLToPath(new URL('../skills/gotreceipts/SKILL.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function installed(repo: string): string {
  return readFileSync(join(repo, SKILL), 'utf8');
}

// --- the text itself ---

test('the skill that ships with the tool is one Claude Code can load', () => {
  const [, header, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(shipped) ?? [];
  assert.ok(header !== undefined && body !== undefined, 'it starts with a header between two "---" lines');
  assert.match(header, /^name: gotreceipts$/m);

  const description = /^description: (.+)$/m.exec(header)?.[1] ?? '';
  assert.ok(description.length > 100, 'the description says when to use the skill');
  assert.ok(description.length < 1536, 'Claude Code cuts a longer description short');
  assert.ok(shipped.split('\n').length < 500, 'a skill is meant to be short');

  // What ships is the same for everyone. The path of one machine is added by "install".
  assert.doesNotMatch(shipped, /On this machine/);
  assert.equal(shipped.includes(MARKER), false);
});

test('every answer the skill quotes is one the tool really gives', () => {
  const source = (readdirSync(sourceFolder, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(join(sourceFolder, file), 'utf8'))
    .join('\n');

  const quoted = [...shipped.matchAll(/\*\*"([^"]+)"\*\*/g)].map((match) => match[1] ?? '');
  assert.ok(quoted.length >= 6, `found only ${quoted.length} quoted answers`);
  for (const answer of quoted) {
    assert.ok(source.includes(answer), `the skill quotes "${answer}", and the tool never prints that`);
  }
});

test('every command the skill names is a command of the tool', (t) => {
  const repo = tempRepo(t);
  const help = runCli(repo, ['--help']).stdout;

  const named = new Set([...shipped.matchAll(/`gotreceipts ([a-z-]+)/g)].map((match) => match[1] ?? ''));
  assert.ok(named.size >= 5, `found only ${named.size} commands`);
  for (const command of named) {
    assert.match(help, new RegExp(`^ {2}${command} `, 'm'), `the skill names "gotreceipts ${command}"`);
  }
});

// --- install ---

test('install writes the skill, and adds how the tool is started on this machine', (t) => {
  const repo = tempRepo(t, { policy: POLICY });

  const result = runCli(repo, ['install']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Claude Code skill: written into \.claude\/skills\/gotreceipts\/SKILL\.md/);
  assert.match(result.stdout, /Claude Code skill\s+INSTALLED\n\s+it tells the agent how to work with the gate\. It stops nothing/);

  const text = installed(repo);
  assert.ok(text.startsWith(shipped.trimEnd()), 'the shipped skill comes first, unchanged');
  assert.ok(text.includes(START_LINE), text.slice(-400));
  assert.ok(text.includes(MARKER));
});

test('the installed skill holds a path of this machine, so it is kept out of git', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const env = noPersonalGitSettings(t);

  const result = runCli(repo, ['install'], env);
  assert.match(result.stdout, /Claude Code skill: written into \S+\n.*It is now kept out of git through \.git\/info\/exclude/);
  assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/skills\/gotreceipts\/SKILL\.md$/m);
  assert.equal(looseFiles(repo, env), '');
});

test('a copy that was changed is reported as out of date, and install writes it again', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);
  const good = installed(repo);

  writeFileSync(join(repo, SKILL), good.replace('Fix the code, never the gate.', 'Do whatever gets you to green.'));
  const doctor = runCli(repo, ['doctor']);
  assert.equal(doctor.status, 0, 'the skill stops nothing, so it is no part of the verdict');
  assert.match(doctor.stdout, /Claude Code skill\s+OUT OF DATE: it is not the text this version of the tool writes/);
  assert.match(doctor.stdout, /run "gotreceipts install" to write it again/);

  const again = runCli(repo, ['install']);
  assert.match(again.stdout, /Claude Code skill: was already in \.claude\/skills\/gotreceipts\/SKILL\.md, written again/);
  assert.equal(installed(repo), good);
  assert.match(runCli(repo, ['doctor']).stdout, /Claude Code skill\s+INSTALLED/);
});

test('a skill of the same name that someone else wrote is never touched', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const theirs = '---\nname: gotreceipts\ndescription: written by hand\n---\nOur own rules.\n';
  writeIn(repo, SKILL, theirs);

  const install = runCli(repo, ['install']);
  assert.equal(install.status, 0, 'both hooks are in place, and the verdict is about the hooks');
  assert.match(install.stdout, /Claude Code skill: NOT WRITTEN: another skill is at \.claude\/skills\/gotreceipts\/SKILL\.md, and this tool did not write it/);
  assert.match(install.stdout, /Claude Code skill\s+NOT INSTALLED: another skill is at/);
  assert.equal(installed(repo), theirs);

  const uninstall = runCli(repo, ['uninstall']);
  assert.match(uninstall.stdout, /Claude Code skill: a skill is there that this tool did not write\. It was left as it is/);
  assert.equal(installed(repo), theirs);
});

test('a copy of the skill that is committed is not written to', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const committed = `An older copy.\n<!-- ${MARKER} -->\n`;
  writeIn(repo, SKILL, committed);
  // Forced, because some machines ignore this folder for every repository.
  assert.equal(gitIn(repo, 'add', '--force', SKILL).status, 0);
  assert.equal(gitIn(repo, 'commit', '--quiet', '-m', 'test: someone committed the installed skill').status, 0);

  const result = runCli(repo, ['install']);
  assert.match(result.stdout, /Claude Code skill: NOT WRITTEN: \.claude\/skills\/gotreceipts\/SKILL\.md is committed in this repository/);
  assert.equal(installed(repo), committed);
});

// --- uninstall ---

test('uninstall removes the skill and the folders that are empty after it', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  assert.equal(runCli(repo, ['install']).status, 0);

  const result = runCli(repo, ['uninstall']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Claude Code skill: removed from \.claude\/skills\/gotreceipts\/SKILL\.md/);
  assert.equal(existsSync(join(repo, '.claude', 'skills')), false);

  assert.match(runCli(repo, ['uninstall']).stdout, /Claude Code skill: was not installed, nothing to remove/);
});

test('uninstall leaves the other skills of the project where they are', (t) => {
  const repo = tempRepo(t, { policy: POLICY });
  const other = writeIn(repo, '.claude/skills/other/SKILL.md', '---\nname: other\ndescription: another skill\n---\nText.\n');
  assert.equal(runCli(repo, ['install']).status, 0);

  assert.equal(runCli(repo, ['uninstall']).status, 0);
  assert.equal(existsSync(join(repo, SKILL)), false);
  assert.equal(existsSync(join(repo, '.claude', 'skills', 'gotreceipts')), false);
  assert.equal(existsSync(other), true);
});
