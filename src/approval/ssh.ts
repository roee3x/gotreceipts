import { spawnSync } from 'node:child_process';
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

export type SignResult = { readonly ok: true; readonly signatureFile: string } | { readonly ok: false; readonly reason: string };

/**
 * Signs a file with a private key. The signature is written next to the file, as "<file>.sig".
 *
 * The program talks to the terminal itself. When the key has a passphrase, it asks the person
 * at the keyboard for it, and this tool never sees what is typed.
 */
export function signFile(keyFile: string, file: string): SignResult {
  const result = spawnSync(SSH_KEYGEN, ['-Y', 'sign', '-f', keyFile, '-n', APPROVAL_NAMESPACE, file], {
    stdio: ['inherit', 'ignore', 'inherit'],
    windowsHide: true,
  });
  if (result.error !== undefined) return { ok: false, reason: missingOr(result.error) };
  if (result.status !== 0) return { ok: false, reason: 'ssh-keygen did not sign. Its own message is above' };
  return { ok: true, signatureFile: `${file}.sig` };
}

export type SignatureCheck =
  /** The signature is good, and it was made by this signer of the list. */
  | { readonly kind: 'good'; readonly signer: string }
  /** The signature was not made by a listed key, or not over these bytes, or not as an approval. */
  | { readonly kind: 'bad'; readonly reason: string }
  /** The check could not be made at all. Never a pass. */
  | { readonly kind: 'cannot-check'; readonly reason: string };

function missingOr(error: Error): string {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'the program "ssh-keygen" was not found. It comes with OpenSSH'
    : `the program "ssh-keygen" could not be started: ${error.message}`;
}

/**
 * Checks a signature over `statement` against the keys of `signers`.
 *
 * The signers are written into a list in the form ssh-keygen reads, in a folder of its own that
 * is removed again. Each key is allowed for approvals only.
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
    writeFileSync(allowed, signers.map((signer) => `${signer.name} namespaces="${APPROVAL_NAMESPACE}" ${signer.key}\n`).join(''));

    // 1. Whose key made the signature? This only looks at the key, not yet at what was signed.
    const found = spawnSync(program, ['-Y', 'find-principals', '-s', signatureFile, '-f', allowed], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (found.error !== undefined) return { kind: 'cannot-check', reason: missingOr(found.error) };
    const signer = found.status === 0 ? found.stdout.split(/\r?\n/)[0]?.trim() : undefined;
    if (signer === undefined || !signers.some((listed) => listed.name === signer)) {
      return { kind: 'bad', reason: 'it was not signed by a key the policy lists' };
    }

    // 2. Is it a signature of exactly these bytes, made as an approval?
    const verified = spawnSync(program, ['-Y', 'verify', '-f', allowed, '-I', signer, '-n', APPROVAL_NAMESPACE, '-s', signatureFile], {
      input: statement,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (verified.error !== undefined) return { kind: 'cannot-check', reason: missingOr(verified.error) };
    if (verified.status !== 0) return { kind: 'bad', reason: 'its signature does not fit its text' };
    return { kind: 'good', signer };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
