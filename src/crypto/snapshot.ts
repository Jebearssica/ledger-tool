/**
 * Encrypted snapshots. See AGENTS.md §3.
 *
 * The repository is PUBLIC. The only data shape allowed to be committed is
 * AES-256-GCM ciphertext, and the key never leaves device memory.
 *
 * Layout (39-byte header, then ciphertext):
 *
 *   0   .. 5    magic "JZLEDG"
 *   6           format version
 *   7   .. 10   PBKDF2 iteration count (uint32, big-endian)
 *   11  .. 26   salt (16 bytes)
 *   27  .. 38   IV (12 bytes)
 *   39  ..      AES-256-GCM ciphertext, authentication tag appended
 *
 * The header is passed as AES-GCM additional authenticated data, so an attacker
 * cannot weaken a snapshot by editing the iteration count or swapping the salt
 * without invalidating the tag.
 *
 * Metadata leaks too: a snapshot that is always a multiple of 4 KiB, filled with
 * random bytes before encryption, keeps file size from revealing how many
 * transactions the user made in a given month.
 */
import type { Transaction } from '../domain/types';
import type { CategoryRule } from '../domain/categories';
import type { Template } from '../importers/template';
import type { AccountRecord, ImportBatch } from '../storage/db';

export const SNAPSHOT_MAGIC = 'JZLEDG';
export const SNAPSHOT_VERSION = 1;

/** AGENTS.md §3 rule 2 mandates at least 600,000 iterations. */
export const PBKDF2_ITERATIONS = 600_000;

/** Padding block size. Larger hides more, at the cost of file size. */
export const PAD_BLOCK_BYTES = 4096;

const SALT_BYTES = 16;
const IV_BYTES = 12;
/** Exported so tests can reason about layout without duplicating the numbers. */
export const SNAPSHOT_HEADER_BYTES = 6 + 1 + 4 + SALT_BYTES + IV_BYTES;
/** AES-GCM appends a 16-byte authentication tag to the ciphertext. */
export const GCM_TAG_BYTES = 16;
const HEADER_BYTES = SNAPSHOT_HEADER_BYTES;

/**
 * Short passphrases are the weakest link here — no amount of PBKDF2 iterations
 * rescues an 6-character password. Enforced rather than merely advised.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

export interface SnapshotPayload {
  schemaVersion: number;
  exportedAt: string;
  transactions: Transaction[];
  batches: ImportBatch[];
  accounts: AccountRecord[];
  templates: Template[];
  rules: CategoryRule[];
}

export interface BuildSnapshotInput {
  transactions: readonly Transaction[];
  batches?: readonly ImportBatch[];
  accounts?: readonly AccountRecord[];
  templates?: readonly Template[];
  rules?: readonly CategoryRule[];
}

export function buildSnapshotPayload(
  input: BuildSnapshotInput,
  now: Date = new Date(),
): SnapshotPayload {
  return {
    schemaVersion: SNAPSHOT_VERSION,
    exportedAt: now.toISOString(),
    transactions: [...input.transactions],
    batches: [...(input.batches ?? [])],
    accounts: [...(input.accounts ?? [])],
    templates: [...(input.templates ?? [])],
    rules: [...(input.rules ?? [])],
  };
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. ` +
        `The snapshot is committed to a public repository, so this is the only thing protecting it.`,
    );
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function padPlaintext(plaintext: Uint8Array): Uint8Array {
  const total = Math.ceil((plaintext.length + 4) / PAD_BLOCK_BYTES) * PAD_BLOCK_BYTES;
  const out = new Uint8Array(total);
  // Random filler, not zeros: two identical ledgers must not encrypt to the
  // same ciphertext, and the tail must not compress or pattern-match.
  crypto.getRandomValues(out);
  new DataView(out.buffer).setUint32(0, plaintext.length, false);
  out.set(plaintext, 4);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new Error('Snapshot is corrupt: payload is shorter than its length prefix.');
  const declared = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0, false);
  if (declared > padded.length - 4) {
    throw new Error('Snapshot is corrupt: declared length exceeds the actual payload.');
  }
  return padded.subarray(4, 4 + declared);
}

export interface EncryptOptions {
  /**
   * Override the iteration count. TEST USE ONLY — lowering this weakens every
   * snapshot produced. Production callers must omit it.
   */
  iterations?: number;
  /** Override the salt/IV. TEST USE ONLY, to make output deterministic. */
  salt?: Uint8Array;
  iv?: Uint8Array;
  /** Skip the passphrase length check. TEST USE ONLY. */
  allowWeakPassphrase?: boolean;
}

export async function encryptSnapshot(
  payload: SnapshotPayload | unknown,
  passphrase: string,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  if (!options.allowWeakPassphrase) assertPassphrase(passphrase);

  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const header = new Uint8Array(HEADER_BYTES);
  header.set(new TextEncoder().encode(SNAPSHOT_MAGIC), 0);
  header[6] = SNAPSHOT_VERSION;
  new DataView(header.buffer).setUint32(7, iterations, false);
  header.set(salt, 11);
  header.set(iv, 27);

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const padded = padPlaintext(plaintext);
  const key = await deriveKey(passphrase, salt, iterations);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: header as BufferSource },
    key,
    padded as BufferSource,
  );

  const out = new Uint8Array(HEADER_BYTES + ciphertext.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(ciphertext), HEADER_BYTES);
  return out;
}

export interface DecryptOptions {
  /**
   * Accept a passphrase shorter than the current minimum. Needed to restore
   * snapshots created before the length rule existed.
   */
  allowWeakPassphrase?: boolean;
}

export async function decryptSnapshot<T = SnapshotPayload>(
  bytes: Uint8Array,
  passphrase: string,
  options: DecryptOptions = {},
): Promise<T> {
  if (!options.allowWeakPassphrase && passphrase.length === 0) {
    throw new Error('A passphrase is required to decrypt this snapshot.');
  }
  if (bytes.length <= HEADER_BYTES) {
    throw new Error('Not a snapshot: the file is too short to contain a header.');
  }

  const magic = new TextDecoder().decode(bytes.subarray(0, 6));
  if (magic !== SNAPSHOT_MAGIC) {
    throw new Error(
      `Not a snapshot file: expected the magic bytes "${SNAPSHOT_MAGIC}" but found "${magic}".`,
    );
  }

  const version = bytes[6];
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(
      `Snapshot format version ${version} is not supported by this build (expected ${SNAPSHOT_VERSION}).`,
    );
  }

  const header = bytes.subarray(0, HEADER_BYTES);
  const iterations = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(7, false);
  const salt = bytes.subarray(11, 27);
  const iv = bytes.subarray(27, 39);
  const ciphertext = bytes.subarray(HEADER_BYTES);

  const key = await deriveKey(passphrase, salt, iterations);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: header as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    // AES-GCM cannot distinguish a wrong key from a tampered ciphertext, and
    // saying so would be misleading. Both mean "do not trust this file".
    throw new Error(
      'Could not decrypt the snapshot. Either the passphrase is wrong, or the file has been modified.',
    );
  }

  const unpadded = unpad(new Uint8Array(plaintext));

  try {
    return JSON.parse(new TextDecoder().decode(unpadded)) as T;
  } catch {
    throw new Error('The snapshot decrypted successfully but does not contain valid JSON.');
  }
}

/** Suggest a filename. `.enc` is in `.gitignore`'s spirit and easy to spot. */
export function snapshotFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return `ledger-${stamp}.enc`;
}
