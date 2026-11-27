// Packs the package the way a release would, installs it in an empty folder, and runs it.
//
// The build and the tests only prove that the code in this folder works.
// This proves that what a user would download works: the right files are in the package,
// nothing else is, and the installed command starts.
//
// It ends with one line: "pack-smoke: PASS ..." or "pack-smoke: FAIL ...".

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The skill that "gotreceipts install" copies into a project. It ships next to the code. */
const SKILL = 'skills/gotreceipts/SKILL.md';
/** The only files a published package may hold, apart from everything under dist/. */
const ALLOWED_OUTSIDE_DIST = ['package.json', 'README.md', 'LICENSE', SKILL];
/** The files it must hold. */
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/cli.js', SKILL];

class SmokeFailure extends Error {}

/** Runs one command line through the system shell and returns what it printed. */
function run(commandLine: string, cwd: string, extraEnv: Record<string, string> = {}): string {
  const env = { ...process.env, ...extraEnv };
  const result = spawnSync(commandLine, { cwd, shell: true, encoding: 'utf8', windowsHide: true, env });
  if (result.error !== undefined) {
    throw new SmokeFailure(`could not start: ${commandLine} (${result.error.message})`);
  }
  if (result.status !== 0) {
    throw new SmokeFailure(`exit code ${result.status} from: ${commandLine}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function smoke(work: string): string {
  const expectedVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

  if (!existsSync(join(root, 'dist', 'cli.js'))) {
    throw new SmokeFailure('dist/cli.js does not exist. Build first: npm run build');
  }

  // 1. Pack. The package is written to the temporary folder, never into the repository.
  const packed = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, root)) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const pack = packed[0];
  if (pack === undefined) throw new SmokeFailure('npm pack reported no package');
  const paths = pack.files.map((file) => file.path.replace(/\\/g, '/'));

  // 2. The package holds what it must, and nothing it must not.
  for (const required of REQUIRED) {
    if (!paths.includes(required)) throw new SmokeFailure(`the package is missing ${required}`);
  }
  const unexpected = paths.filter((path) => !path.startsWith('dist/') && !ALLOWED_OUTSIDE_DIST.includes(path));
  if (unexpected.length > 0) {
    throw new SmokeFailure(`the package holds files it should not: ${unexpected.join(', ')}`);
  }

  // 3. Install it in an empty project.
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{ "private": true }\n');
  run(`npm install --no-audit --no-fund --ignore-scripts --no-package-lock "${join(work, pack.filename)}"`, project);

  // 4. Run the installed command, through the same small launcher file a user's shell would use.
  const launcher = join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'gotreceipts.cmd' : 'gotreceipts');
  const version = run(`"${launcher}" --version`, project).trim();
  if (version !== expectedVersion) {
    throw new SmokeFailure(`the installed command reports version "${version}", expected "${expectedVersion}"`);
  }
  const help = run(`"${launcher}" --help`, project);
  if (!help.includes('Usage: gotreceipts')) {
    throw new SmokeFailure('the installed command did not print its help');
  }

  // 5. Let the installed command set up a repository. This proves that it finds the skill that
  //    came in the package, from the place a user's copy of the tool is in.
  //    Git is told to read no settings of the person or the machine running this.
  const noSettings = join(work, 'gitconfig');
  writeFileSync(noSettings, '');
  const gitEnv = { GIT_CONFIG_GLOBAL: noSettings, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: work };
  run('git init --quiet', project, gitEnv);
  const policy = {
    schema: 1,
    levels: [{ name: 'G0', checks: [{ name: 'node', run: 'node --version' }] }],
    tiers: [{ branch: 'main', level: 'G0' }],
  };
  writeFileSync(join(project, 'gotreceipts.json'), `${JSON.stringify(policy)}\n`);
  const setUp = run(`"${launcher}" install`, project, gitEnv);
  if (!setUp.includes('VERDICT: PASS')) {
    throw new SmokeFailure(`the installed command could not set up a repository:\n${setUp}`);
  }
  const skill = join(project, '.claude', 'skills', 'gotreceipts', 'SKILL.md');
  if (!existsSync(skill) || !readFileSync(skill, 'utf8').startsWith('---\nname: gotreceipts\n')) {
    throw new SmokeFailure('the installed command did not write its skill into the repository');
  }

  return `installed gotreceipts ${version} from a package of ${paths.length} files, ran it, and set up a repository with it`;
}

const work = mkdtempSync(join(tmpdir(), 'gotreceipts-smoke-'));
try {
  console.log(`pack-smoke: PASS (${smoke(work)})`);
} catch (error) {
  // An unexpected error is a failure too. It is never allowed to look like a pass.
  console.log(`pack-smoke: FAIL (${error instanceof Error ? error.message : String(error)})`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
