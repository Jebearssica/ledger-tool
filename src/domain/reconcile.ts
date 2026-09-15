/**
 * Reconciling a re-import against what is already stored. See AGENTS.md §5, §7.
 *
 * The fingerprint identifies a transaction across imports, so an incoming row
 * whose fingerprint is already in storage describes the SAME transaction. The
 * pipeline used to discard such a row outright, which made the store
 * effectively append-only: once a period had been imported, no later parse could
 * ever correct it. That is the wrong default, because the usual reason to import
 * a file that overlaps what you already have is precisely that the newer parse
 * is better — a parser or classifier fix, or an export that covers the period
 * properly this time.
 *
 * The overlap is detected by FINGERPRINT, not by date range. Two accounts
 * routinely cover the same months without describing the same transactions, so a
 * date-range rule would let one of them overwrite the other's rows; matching on
 * the fingerprint only ever touches the row that was genuinely re-described.
 *
 * Updates are applied only when the content actually differs, which keeps the
 * idempotency guarantee intact (AGENTS.md §5): re-importing an unchanged file
 * changes nothing at all, not even the stored rows' provenance.
 */
import type { Transaction } from './types';
import { formatMinor } from './money';

export interface UpdatedRow {
  fingerprint: string;
  /** The row as stored before this import. */
  before: Transaction;
  /** The row as it will be stored afterwards. */
  after: Transaction;
  /** Field-level summary of the correction, so the user can check it. */
  changes: string[];
}

/**
 * `meta` keys that describe the fingerprint rather than the transaction.
 *
 * Excluded from the change list because they are long, opaque, and — since the
 * two rows share a fingerprint — equal by construction anyway.
 */
const META_KEYS_THAT_ARE_NOT_CONTENT = new Set(['preimage']);

/**
 * The row's content, as a comparable string.
 *
 * `importedBatchId` is deliberately absent: it is provenance stamped at save
 * time, not content, and it differs on every import. Including it would make
 * every re-import look like a correction and churn the whole store.
 */
function contentSignature(tx: Transaction): string {
  return JSON.stringify({
    source: tx.source,
    accountId: tx.accountId,
    direction: tx.direction,
    amountMinor: tx.amountMinor,
    currency: tx.currency,
    occurredAt: tx.occurredAt,
    counterparty: tx.counterparty ?? null,
    balanceAfterMinor: tx.balanceAfterMinor ?? null,
    rawDescription: tx.rawDescription,
    category: tx.category ?? null,
    categorySource: tx.categorySource,
    kind: tx.kind,
    sourceOrderId: tx.sourceOrderId ?? null,
    // Sorted, so the order the keys happen to sit in cannot make two otherwise
    // identical rows look different.
    meta: tx.meta
      ? Object.keys(tx.meta)
          .sort()
          .map((key) => [key, tx.meta?.[key] ?? null])
      : null,
  });
}

function show(value: string | number | undefined | null): string {
  return value === undefined || value === null || value === '' ? '(none)' : String(value);
}

/** Human-readable list of what a correction changes, for the import preview. */
export function describeChanges(before: Transaction, after: Transaction): string[] {
  const changes: string[] = [];

  if (before.amountMinor !== after.amountMinor) {
    changes.push(`amount ${formatMinor(before.amountMinor)} -> ${formatMinor(after.amountMinor)}`);
  }
  if (before.kind !== after.kind) changes.push(`kind ${before.kind} -> ${after.kind}`);
  if (before.direction !== after.direction) {
    changes.push(`direction ${before.direction} -> ${after.direction}`);
  }
  if ((before.category ?? '') !== (after.category ?? '')) {
    changes.push(`category ${show(before.category)} -> ${show(after.category)}`);
  }
  if (before.occurredAt !== after.occurredAt) {
    changes.push(`time ${before.occurredAt} -> ${after.occurredAt}`);
  }
  if ((before.counterparty ?? '') !== (after.counterparty ?? '')) {
    changes.push(`counterparty ${show(before.counterparty)} -> ${show(after.counterparty)}`);
  }
  if (before.rawDescription !== after.rawDescription) {
    changes.push(`description ${show(before.rawDescription)} -> ${show(after.rawDescription)}`);
  }

  // Everything else that can differ lives in `meta` — the status wording, the
  // transaction type, and the refund-netting figures. Report the keys rather
  // than letting a correction happen silently.
  const keys = new Set([...Object.keys(before.meta ?? {}), ...Object.keys(after.meta ?? {})]);
  for (const key of [...keys].sort()) {
    if (META_KEYS_THAT_ARE_NOT_CONTENT.has(key)) continue;
    const from = before.meta?.[key];
    const to = after.meta?.[key];
    if (from !== to) changes.push(`${key} ${show(from)} -> ${show(to)}`);
  }

  return changes;
}

/**
 * Decide whether an incoming row corrects a stored one.
 *
 * @returns the row to store instead, or `null` when the incoming row says nothing
 *   new — in which case it is an ordinary duplicate and must be left alone.
 */
export function reconcileOverlap(
  stored: Transaction,
  incoming: Transaction,
): UpdatedRow | null {
  /**
   * A category the user set by hand outranks anything an import can infer, so it
   * is carried across instead of being replaced by the rule engine's answer
   * (AGENTS.md §7). Without this, re-importing a file would silently undo every
   * manual correction made to it — the exact thing §7 forbids.
   */
  const corrected: Transaction =
    stored.categorySource === 'user'
      ? { ...incoming, category: stored.category, categorySource: 'user' }
      : incoming;

  /**
   * The store's primary key stays put.
   *
   * The pipeline derives the id from the fingerprint, so this is normally a
   * no-op — but a record that reached storage another way (a restored snapshot,
   * an older build) could carry a different id, and then writing a new one would
   * collide with the unique fingerprint index and abort the whole import. A
   * correction changes a record's content, never its identity.
   */
  const after: Transaction = { ...corrected, id: stored.id };

  if (contentSignature(after) === contentSignature(stored)) return null;

  return {
    fingerprint: stored.fingerprint,
    before: stored,
    after,
    changes: describeChanges(stored, after),
  };
}
