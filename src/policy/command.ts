import { parseArgs } from 'node:util';

import { EXIT, type ExitCode } from '../exit-codes.ts';
import type { Io } from '../main.ts';
import { policyId } from './hash.ts';
import { loadPolicy } from './load.ts';
import { checksForLevel } from './policy.ts';

export const POLICY_USAGE = [
  'Usage: gotreceipts policy [options]',
  '',
  'Reads gotreceipts.json, checks it, and shows what the gate will do.',
  '',
  'Options:',
  '  --file <file>   Read this policy file instead of gotreceipts.json at the top of the repository',
  '  -h, --help      Show this help',
  '',
  'Exit codes: 0 = the policy is valid, 2 = it is missing or has errors.',
].join('\n');

export async function policyCommand(args: readonly string[], io: Io): Promise<ExitCode> {
  let options: { file?: string; help?: boolean };
  try {
    options = parseArgs({
      args: [...args],
      options: { file: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.err(`gotreceipts policy: ${error instanceof Error ? error.message : String(error)}`);
    io.err(POLICY_USAGE);
    return EXIT.CANNOT_RUN;
  }

  if (options.help === true) {
    io.out(POLICY_USAGE);
    return EXIT.PASS;
  }

  const loaded = loadPolicy(process.cwd(), options.file);
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`gotreceipts policy: CANNOT RUN: ${error}`);
    return EXIT.CANNOT_RUN;
  }

  const { policy } = loaded;
  const width = (values: readonly string[]): number => Math.max(...values.map((value) => value.length));

  io.out('The policy is valid.');
  io.out(`Policy id: ${policyId(policy)}`);
  io.out('');

  io.out('Levels (each level also runs every check of the levels above it in this list)');
  const levelWidth = width(policy.levels.map((level) => level.name));
  for (const level of policy.levels) {
    const all = checksForLevel(policy, level.name) ?? [];
    const names = all.map((check) => check.name).join(', ');
    io.out(`  ${level.name.padEnd(levelWidth)}  ${all.length} checks: ${names}`);
  }
  io.out('');

  io.out('Branches (the level a commit needs before it may enter the branch)');
  const branchWidth = width(policy.tiers.map((tier) => tier.branch));
  for (const tier of policy.tiers) {
    io.out(`  ${tier.branch.padEnd(branchWidth)}  ${tier.level}`);
  }
  io.out('');

  io.out(`A record counts for ${policy.record.maxAgeHours} hours.`);
  return EXIT.PASS;
}
