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

/**
 * Bump this whenever the algorithm below changes: every historical fingerprint
 * becomes invalid, so a migration is mandatory (AGENTS.md §5).
 *
 * v1 -> v2: prefer the platform transaction id, and include the description in
 * the fallback. v1 silently merged distinct transactions; see below.
 */
export const FINGERPRINT_VERSION = 2;

/** Window within which two statement rows are considered the same event. */
export const TIME_WINDOW_MINUTES = 2;

export interface FingerprintInput {
  occurredAt: string;
  amountMinor: number;
  direction: Direction;
  counterparty?: string | undefined;
  balanceAfterMinor?: number | undefined;
  /** The platform's own transaction id, when the export provides one. */
  orderId?: string | undefined;
  /** Original description. Discriminates rows that are otherwise identical. */
  description?: string | undefined;
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

function normalizeDescription(value: string | undefined): string {
  if (!value) return '';
  return value.normalize('NFKC').toLowerCase().replace(/[\s\u00a0]+/g, '');
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
 * Three strategies, strongest first:
 *
 *   1. The platform's own transaction id. It is unique and stable, so it needs
 *      no heuristics at all, and it also dedupes correctly ACROSS overlapping
 *      exports (a monthly and a yearly export of the same payment agree).
 *   2. A running balance, which is unique per row by construction.
 *   3. A ±`TIME_WINDOW_MINUTES` bucket plus amount, direction, counterparty and
 *      description.
 *
 * Strategy 3 is the weak one, and v1 got it wrong in a way worth recording.
 * Alipay's statement carries no balance column, and its auto-invest rows (定投)
 * fire several orders for the SAME fund platform within the SAME minute, each
 * for an equal round amount — "buy 100 of fund A", "buy 100 of fund B" at
 * 10:55:35 and 10:55:38. With only time+amount+counterparty they hash
 * identically, so v2 of these rows were silently dropped as duplicates.
 *
 * Adding the description fixes that, because the fund name is what differs. It
 * is still stable across re-imports, so idempotency is preserved.
 */
export function fingerprintPreimage(input: FingerprintInput): string {
  const { amountMinor, direction, counterparty, balanceAfterMinor, orderId, description } = input;

  const trimmedOrderId = orderId?.trim() ?? '';
  if (trimmedOrderId !== '') {
    // The amount is included alongside the id on purpose. One platform
    // transaction can legitimately become TWO records: WeChat folds a service
    // fee into the principal, and the importer splits them so only the fee
    // counts as spending. Both halves share the order id, so keying on the id
    // alone would silently collapse them back into one. Re-importing the same
    // file still reproduces both, so idempotency is unaffected.
    return [`v${FINGERPRINT_VERSION}`, 'ord', trimmedOrderId, String(amountMinor), direction].join('|');
  }

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
    normalizeDescription(description),
  ].join('|');
}

export function fingerprint(input: FingerprintInput): string {
  return fnv1a64Hex(fingerprintPreimage(input));
}

/** Stable id derived from the fingerprint; stable ids keep React keys and diffing sane. */
export function transactionIdFromFingerprint(fp: string): string {
  return `tx_${fp}`;
}
