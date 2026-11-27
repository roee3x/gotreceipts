/** A JSON object: names with values. Not a list, and not null. */
export type JsonObject = Record<string, unknown>;

/**
 * True for a JSON object. Everything this tool reads from outside is JSON it did not write
 * itself in this run: the policy, a record, an approval, the answer of another program. Each
 * reader starts with this question, so it is asked in one place.
 */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
