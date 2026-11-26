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

/** The only files a published package may hold, apart from everything under dist/. */
const ALLOWED_TOP_LEVEL = ['package.json', 'README.md', 'LICENSE'];
/** The files it must hold. */
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'dist/cli.js'];

class SmokeFailure extends Error {}

/** Runs one command line through the system shell and returns what it printed. */
function run(commandLine: string, cwd: string): string {
  const result = spawnSync(commandLine, { cwd, shell: true, encoding: 'utf8', windowsHide: true });
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
  const unexpected = paths.filter((path) => !path.startsWith('dist/') && !ALLOWED_TOP_LEVEL.includes(path));
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

  return `installed gotreceipts ${version} from a package of ${paths.length} files, and ran it`;
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
