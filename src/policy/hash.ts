import { createHash } from 'node:crypto';

import type { Policy } from './policy.ts';

/** Writes a value as JSON with the keys of every object in alphabetical order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The identity of a policy: a fingerprint of what it means, not of how the file is laid out.
 *
 * Spacing, key order and writing out a default value do not change it.
 * Any change to a check, a level or a tier does.
 * A record carries this id, so a record made under another policy can be told apart.
 */
export function policyId(policy: Policy): string {
  return `sha256:${createHash('sha256').update(canonical(policy)).digest('hex')}`;
}
