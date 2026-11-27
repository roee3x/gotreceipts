import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Signer } from '../policy/policy.ts';
import { APPROVAL_NAMESPACE } from './statement.ts';

/**
 * Signing and checking a signature, with the program "ssh-keygen".
 *
 * It is the same mechanism git uses for signed commits, and it comes with OpenSSH, which is on
 * every machine that has git. So an approval needs nothing new installed, and its signature can
 * be checked by anyone with the standard tool, without this one.
 *
 * Checked against the ssh-keygen manual (the "-Y" options) on 2026-11-27, with OpenSSH 9.8.
 */

/**
 * The program. Its name is fixed in the code on purpose: no setting and no environment variable
 * can point the tool at another program that says "good signature" to everything.
 */
const SSH_KEYGEN = 'ssh-keygen';

/** Why the program did not start. */
function whyNotStarted(error: Error): string {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'the program "ssh-keygen" was not found. It comes with OpenSSH'
    : `the program "ssh-keygen" could not be started: ${error.message}`;
}

// --- signing ---

export type SignResult = { readonly ok: true; readonly signatureFile: string } | { readonly ok: false; readonly reason: string };

/**
 * Signs a file with a private key. The signature is written next to the file, as "<file>.sig".
 *
 * The program talks to the terminal itself. When the key has a passphrase, it asks the person
 * at the keyboard for it, and this tool never sees what is typed.
 */
export function signFile(keyFile: string, file: string): SignResult {
  const signed = spawnSync(SSH_KEYGEN, ['-Y', 'sign', '-f', keyFile, '-n', APPROVAL_NAMESPACE, file], {
    stdio: ['inherit', 'ignore', 'inherit'],
    windowsHide: true,
  });
  if (signed.error !== undefined) return { ok: false, reason: whyNotStarted(signed.error) };
  if (signed.status !== 0) return { ok: false, reason: 'ssh-keygen did not sign. Its own message is above' };
  return { ok: true, signatureFile: `${file}.sig` };
}

// --- checking ---

export type SignatureCheck =
  /** The signature is good, and it was made by this signer of the list. */
  | { readonly kind: 'good'; readonly signer: string }
  /** The signature was not made by a listed key, or not over these bytes, or not as an approval. */
  | { readonly kind: 'bad'; readonly reason: string }
  /** The check could not be made at all. Never a pass. */
  | { readonly kind: 'cannot-check'; readonly reason: string };

/** The signers as a list in the form ssh-keygen reads: one line each. Each key is allowed for approvals only. */
function allowedSigners(signers: readonly Signer[]): string {
  return signers.map((signer) => `${signer.name} namespaces="${APPROVAL_NAMESPACE}" ${signer.key}\n`).join('');
}

/** How one run of the program went: it did not start, or it ended well or badly and printed something. */
type Ran = { readonly started: false; readonly why: string } | { readonly started: true; readonly ok: boolean; readonly printed: string };

/** Runs the program and waits for it. `input` is what it reads, when it is given something to read. */
function run(program: string, args: readonly string[], input?: Buffer): Ran {
  const options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8', windowsHide: true, ...(input === undefined ? {} : { input }) };
  const result = spawnSync(program, [...args], options);
  if (result.error !== undefined) return { started: false, why: whyNotStarted(result.error) };
  return { started: true, ok: result.status === 0, printed: result.stdout };
}

/**
 * Checks a signature over `statement` against the keys of `signers`.
 *
 * The list of signers is written into a folder of its own, which is removed again.
 *
 * `program` is there for one test, which checks what happens on a machine without ssh-keygen.
 */
export function checkSignature(signers: readonly Signer[], statement: Buffer, signatureFile: string, program = SSH_KEYGEN): SignatureCheck {
  let folder: string;
  try {
    folder = mkdtempSync(join(tmpdir(), 'gotreceipts-signers-'));
  } catch (error) {
    return { kind: 'cannot-check', reason: `no temporary folder could be made: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const allowed = join(folder, 'allowed_signers');
    writeFileSync(allowed, allowedSigners(signers));

    // 1. Whose key made the signature? This only looks at the key, not yet at what was signed.
    const found = run(program, ['-Y', 'find-principals', '-s', signatureFile, '-f', allowed]);
    if (!found.started) return { kind: 'cannot-check', reason: found.why };
    const signer = found.ok ? found.printed.split(/\r?\n/)[0]?.trim() : undefined;
    if (signer === undefined || !signers.some((listed) => listed.name === signer)) {
      return { kind: 'bad', reason: 'it was not signed by a key the policy lists' };
    }

    // 2. Is it a signature of exactly these bytes, made as an approval?
    const verified = run(program, ['-Y', 'verify', '-f', allowed, '-I', signer, '-n', APPROVAL_NAMESPACE, '-s', signatureFile], statement);
    if (!verified.started) return { kind: 'cannot-check', reason: verified.why };
    if (!verified.ok) return { kind: 'bad', reason: 'its signature does not fit its text' };
    return { kind: 'good', signer };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
