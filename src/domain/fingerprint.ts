/**
 * Transaction fingerprinting for deduplication. See AGENTS.md §5.
 *
 * The fingerprint is what makes imports idempotent: importing the same file
 * twice must not change a single total. It is therefore a PURE and STABLE
 * function — changing the algorithm invalidates every historical fingerprint,
 * so any change must bump `FINGERPRINT_VERSION` and ship a migration.
 */
import type { Direction } from './types';
import { bucketEpochSeconds, epochSeconds } from './dates';

export const FINGERPRINT_VERSION = 1;

/** Window within which two statement rows are considered the same event. */
export const TIME_WINDOW_MINUTES = 2;

export interface FingerprintInput {
  occurredAt: string;
  amountMinor: number;
  direction: Direction;
  counterparty?: string | undefined;
  balanceAfterMinor?: number | undefined;
}

/** Collapse cosmetic differences so the same payee hashes identically. */
export function normalizeCounterparty(value: string | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[（）()【】\[\]]/g, '');
}

/**
 * 64-bit FNV-1a, rendered as 16 hex chars.
 *
 * Chosen over `crypto.subtle.digest` because fingerprints must be computable
 * synchronously and identically in tests, workers and the browser. This is a
 * dedupe key, not a security boundary — the threat model is "the same row
 * imported twice", so collision resistance against an adversary is not needed.
 */
export function fnv1a64Hex(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Build the canonical pre-image string for a row, then hash it.
 *
 * Two strategies, in priority order (AGENTS.md §5):
 *   1. A running balance is the strongest signal — it is unique per row, so no
 *      time bucketing is needed.
 *   2. Otherwise fall back to a ±`TIME_WINDOW_MINUTES` bucket plus
 *      amount/direction/counterparty.
 *
 * Tradeoff worth knowing: strategy 2 can merge two genuinely distinct purchases
 * of the same amount from the same merchant within the same 2-minute bucket.
 * That is preferred over the alternative failure, which is double-counting them
 * on every re-import.
 */
export function fingerprintPreimage(input: FingerprintInput): string {
  const { amountMinor, direction, counterparty, balanceAfterMinor } = input;

  if (balanceAfterMinor !== undefined && Number.isFinite(balanceAfterMinor)) {
    return [
      `v${FINGERPRINT_VERSION}`,
      'bal',
      String(balanceAfterMinor),
      String(epochSeconds(input.occurredAt)),
      String(amountMinor),
      direction,
    ].join('|');
  }

  return [
    `v${FINGERPRINT_VERSION}`,
    'win',
    String(bucketEpochSeconds(input.occurredAt, TIME_WINDOW_MINUTES)),
    String(amountMinor),
    direction,
    normalizeCounterparty(counterparty),
  ].join('|');
}

export function fingerprint(input: FingerprintInput): string {
  return fnv1a64Hex(fingerprintPreimage(input));
}

/** Stable id derived from the fingerprint; stable ids keep React keys and diffing sane. */
export function transactionIdFromFingerprint(fp: string): string {
  return `tx_${fp}`;
}
