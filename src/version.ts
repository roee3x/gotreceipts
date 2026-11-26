import { readFileSync } from 'node:fs';

/**
 * Reads the tool's version from its own package.json.
 * The file sits one folder above this module, both in the source tree and in the build.
 */
export function readVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  throw new Error('package.json has no version field');
}
