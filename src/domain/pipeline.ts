/**
 * The import pipeline: drafts → persisted transactions.
 *
 * Stage order matters and is not arbitrary:
 *
 *   1. drop impossible rows   (a closed transaction never happened)
 *   2. pair refunds           (needs orderId, so must precede hashing; full
 *                              refunds remove both rows, partial refunds reduce
 *                              the purchase's amount in place)
 *   3. convert to transactions(assign kind, fingerprint)
 *   4. pair transfers         (may reclassify expense/income → transfer-internal)
 *   5. categorise             (after pairing, so transfers are never categorised)
 *   6. deduplicate            (fingerprint is the idempotency key)
 *
 * Every stage is pure, so the whole pipeline is replayable from fixtures.
 */
import type {
  DraftTransaction,
  ParseWarning,
  Transaction,
} from './types';
import { categorize, type CategoryRule } from './categories';
import { classifyKind, disclosedPartialRefundMinor, isClosedOrFailed, isRefundRow } from './classify';
import { formatMinor } from './money';
import { fingerprintPreimage, fingerprint, transactionIdFromFingerprint, FINGERPRINT_VERSION } from './fingerprint';
import { pairInternalTransfers, type PairingOptions, type TransferPair } from './transfers';

export type DropReason = 'closed-or-failed' | 'refund-paired' | 'refund-partial' | 'duplicate';

export interface DroppedRow {
  reason: DropReason;
  detail: string;
  /** Enough of the original row to show the user what was excluded and why. */
  preview: {
    occurredAt: string;
    amountMinor: number;
    direction: string;
    description: string;
    source: string;
  };
}

export interface PipelineContext {
  batchId: string;
  rules: readonly CategoryRule[];
  pairing?: Partial<PairingOptions>;
  /** Fingerprints already in storage; anything matching is skipped. */
  existingFingerprints?: ReadonlySet<string>;
}

export interface PipelineOutcome {
  /** New rows, ready to persist. */
  transactions: Transaction[];
  /**
   * Rows that matched an existing fingerprint (or an earlier row in this same
   * import) and were therefore skipped. This is what makes imports idempotent.
   */
  duplicates: Transaction[];
  dropped: DroppedRow[];
  pairs: TransferPair[];
  warnings: ParseWarning[];
}

function preview(draft: DraftTransaction): DroppedRow['preview'] {
  return {
    occurredAt: draft.occurredAt,
    amountMinor: draft.amountMinor,
    direction: draft.direction,
    description: draft.description,
    source: draft.source,
  };
}

/**
 * Refunds are not income, and a partial refund is not a full one.
 *
 * Alipay records a refund as its own row: `交易状态 = 退款成功`, `交易分类 = 退款`.
 * If it is left in, the original purchase counts as an expense AND the refund
 * counts as income, so both sides are overstated by the same amount.
 *
 * Matching rule (AGENTS.md §5): the refund's order id has the original's order
 * id as a prefix. The AMOUNTS must not be required to match — that was the v1
 * rule, and it is wrong for the single most common real case. A grocery
 * substitution ("多退少补") refunds the price difference, so a year of real data
 * contained 21 refunds of ¥0.11–¥1.25 against ¥39–¥48 orders, every one of which
 * v1 reported as "no matching purchase". Netting a ¥0.30 refund against a ¥43.19
 * purchase as if it were a full refund would erase ¥42.89 of real spending, so
 * the distinction has to be made explicitly:
 *
 *   refund == purchase  → full refund    → remove BOTH rows
 *   refund <  purchase  → partial refund → keep the purchase, reduced by the
 *                                          refund. Net cashflow is then exact.
 *   refund >  purchase  → anomaly        → remove the purchase, keep the refund
 *                                          unbudgeted and warn; never invent a
 *                                          negative expense.
 *
 * A refund whose purchase the platform marked 交易关闭 is NOT an anomaly: the
 * "refund" is the reversal of a payment that never happened. Ten of those occur
 * in one year of real data, and warning about them is pure noise.
 *
 * Not every platform pairs by order id. WeChat instead rewrites the purchase
 * row's own status to carry the refunded figure and gives the refund leg an
 * unrelated order id, so no rewriting of the rule above can connect the two.
 * That second, self-disclosed shape is netted at the end of this function — see
 * `disclosedPartialRefundMinor`.
 */
function pairRefunds(
  drafts: readonly DraftTransaction[],
  closedOrderIds: ReadonlySet<string>,
): {
  kept: DraftTransaction[];
  dropped: DroppedRow[];
  warnings: ParseWarning[];
} {
  const dropped: DroppedRow[] = [];
  const warnings: ParseWarning[] = [];
  const removed = new Set<number>();
  /** Refund money already netted against each purchase row, by draft index. */
  const netted = new Map<number, number>();

  const nettedOf = (index: number): number => netted.get(index) ?? 0;
  /** What is left of a purchase once earlier refunds in this file took their cut. */
  const remainingOf = (index: number): number =>
    (drafts[index]?.amountMinor ?? 0) - nettedOf(index);

  drafts.forEach((refund, refundIndex) => {
    if (!isRefundRow(refund)) return;

    const refundOrderId = refund.orderId ?? '';
    if (refundOrderId === '') {
      warnings.push({
        code: 'refund-without-order-id',
        message: `A refund row has no order id, so the original purchase could not be found. It is kept as "refund" and excluded from totals.`,
      });
      return;
    }

    const originalIndex = drafts.findIndex((candidate, candidateIndex) => {
      if (candidateIndex === refundIndex || removed.has(candidateIndex)) return false;
      // A refund is never the original purchase of another refund.
      if (isRefundRow(candidate)) return false;
      const candidateOrderId = candidate.orderId ?? '';
      if (candidateOrderId === '') return false;
      if (!refundOrderId.startsWith(candidateOrderId)) return false;
      return remainingOf(candidateIndex) > 0;
    });

    if (originalIndex === -1) {
      // A purchase already dropped for being closed explains this exactly.
      const reversesFailedPayment = [...closedOrderIds].some((id) =>
        refundOrderId.startsWith(id),
      );
      if (!reversesFailedPayment) {
        warnings.push({
          code: 'refund-unmatched',
          message: `Refund (order ${refundOrderId.slice(0, 12)}…) has no matching purchase in this import. It is kept as "refund" and excluded from totals.`,
        });
      }
      return;
    }

    const original = drafts[originalIndex]!;
    const remaining = remainingOf(originalIndex);
    const leftover = refund.amountMinor - remaining;

    if (leftover === 0) {
      removed.add(refundIndex);
      removed.add(originalIndex);
      dropped.push({
        reason: 'refund-paired',
        detail: 'Refund and its original purchase cancelled each other out.',
        preview: preview(refund),
      });
      dropped.push({
        reason: 'refund-paired',
        detail: 'Original purchase, cancelled by a matching refund.',
        preview: preview(original),
      });
      return;
    }

    if (leftover < 0) {
      // Partial refund: only the difference came back, so the purchase stays as
      // real spending but for less. Both halves have to disappear from the row
      // list, or the refund would still be counted as income (AGENTS.md §5).
      removed.add(refundIndex);
      netted.set(originalIndex, nettedOf(originalIndex) + refund.amountMinor);
      dropped.push({
        reason: 'refund-partial',
        detail: `Partial refund of ${formatMinor(refund.amountMinor)} netted against the purchase, which is kept at the reduced amount. No warning: totals are exact.`,
        preview: preview(refund),
      });
      return;
    }

    // The refund returns more than the purchase we hold. Netting would produce a
    // negative expense, so drop the purchase outright and surface the excess
    // instead of guessing what it is.
    removed.add(originalIndex);
    dropped.push({
      reason: 'refund-paired',
      detail: 'Original purchase, cancelled by a matching refund.',
      preview: preview(original),
    });
    warnings.push({
      code: 'refund-exceeds-purchase',
      message: `Refund (order ${refundOrderId.slice(0, 12)}…) returns ${formatMinor(refund.amountMinor)} for a purchase of ${formatMinor(remaining)}. The purchase was cancelled, but the difference of ${formatMinor(leftover)} is not counted anywhere — please check it.`,
    });
  });

  const kept = drafts
    .map((draft, index) => {
      if (removed.has(index)) return null;

      // A refund the row itself discloses. WeChat never links a refund to its
      // purchase by id, so the pairing loop above cannot find the pair however it
      // is written; the figure in the purchase's own 当前状态 is the only signal.
      // Leaving it out discarded the whole purchase, so the ¥145 that genuinely
      // left the account appeared in no total at all.
      //
      // Skipped when pairing already took its cut, or the same money would be
      // deducted twice and spending would be understated instead.
      const paired = nettedOf(index);
      const disclosed = paired === 0 ? (disclosedPartialRefundMinor(draft) ?? 0) : 0;
      const deducted = paired + disclosed;

      if (deducted === 0) return draft;
      return { ...draft, amountMinor: draft.amountMinor - deducted, refundNettedMinor: deducted };
    })
    .filter((draft): draft is DraftTransaction => draft !== null);

  return { kept, dropped, warnings };
}

function toTransaction(draft: DraftTransaction, batchId: string): Transaction {
  const kind = isRefundRow(draft) ? 'refund' : classifyKind(draft);

  // A partial refund has already reduced `amountMinor`, but the fingerprint must
  // be built from the figure on the statement. Otherwise a monthly and a yearly
  // export of the same period — only one of which carries the refund row — would
  // hash the same purchase differently and import it twice.
  const statedAmountMinor = draft.amountMinor + (draft.refundNettedMinor ?? 0);

  const fpInput = {
    occurredAt: draft.occurredAt,
    amountMinor: statedAmountMinor,
    direction: draft.direction,
    counterparty: draft.counterparty,
    balanceAfterMinor: draft.balanceAfterMinor,
    orderId: draft.orderId,
    description: draft.description,
  };

  const fp = fingerprint(fpInput);

  const meta: Record<string, string> = {};
  if (draft.txType) meta['txType'] = draft.txType;
  if (draft.method) meta['method'] = draft.method;
  if (draft.status) meta['status'] = draft.status;
  if (draft.orderId) meta['orderId'] = draft.orderId;
  if (draft.merchantOrderId) meta['merchantOrderId'] = draft.merchantOrderId;
  if (draft.refundNettedMinor) {
    meta['refundNettedMinor'] = String(draft.refundNettedMinor);
    meta['statedAmountMinor'] = String(statedAmountMinor);
  }
  meta['preimage'] = fingerprintPreimage(fpInput);

  return {
    id: transactionIdFromFingerprint(fp),
    fingerprint: fp,
    fingerprintVersion: FINGERPRINT_VERSION,
    source: draft.source,
    accountId: draft.accountId,
    direction: draft.direction,
    amountMinor: draft.amountMinor,
    currency: draft.currency,
    occurredAt: draft.occurredAt,
    counterparty: draft.counterparty,
    balanceAfterMinor: draft.balanceAfterMinor,
    rawDescription: draft.description,
    categorySource: 'none',
    kind,
    importedBatchId: batchId,
    sourceOrderId: draft.orderId,
    meta,
  };
}

/** Categorisation applies to cashflow rows only; transfers must stay unlabelled. */
function isCategorisable(tx: Transaction): boolean {
  return tx.kind === 'expense' || tx.kind === 'income' || tx.kind === 'refund';
}

function categorizeTransaction(tx: Transaction, rules: readonly CategoryRule[]): Transaction {
  if (tx.categorySource === 'user') return tx;

  const assignment = categorize(
    {
      source: tx.source,
      accountId: tx.accountId,
      direction: tx.direction,
      amountMinor: tx.amountMinor,
      currency: tx.currency,
      occurredAt: tx.occurredAt,
      counterparty: tx.counterparty,
      description: tx.rawDescription,
      txType: tx.meta?.['txType'],
      method: tx.meta?.['method'],
      excludedFromCashflow: false,
      raw: {},
    },
    rules,
  );

  return { ...tx, category: assignment.category, categorySource: assignment.categorySource };
}

export function buildTransactions(
  drafts: readonly DraftTransaction[],
  context: PipelineContext,
): PipelineOutcome {
  const warnings: ParseWarning[] = [];
  const dropped: DroppedRow[] = [];

  // ---- 1. Drop rows the platform says never happened ---------------------
  const live: DraftTransaction[] = [];
  // Remembered so stage 2 can tell a genuinely orphaned refund apart from the
  // benign reversal of a payment that was cancelled before it settled.
  const closedOrderIds = new Set<string>();
  for (const draft of drafts) {
    if (isClosedOrFailed(draft)) {
      if (draft.orderId) closedOrderIds.add(draft.orderId);
      dropped.push({
        reason: 'closed-or-failed',
        detail: `Status "${draft.status ?? draft.description}" means this transaction never completed.`,
        preview: preview(draft),
      });
      continue;
    }
    live.push(draft);
  }

  // ---- 2. Cancel refunds against their original purchase -----------------
  const refundResult = pairRefunds(live, closedOrderIds);
  dropped.push(...refundResult.dropped);
  warnings.push(...refundResult.warnings);

  // ---- 3. Materialise transactions --------------------------------------
  let transactions = refundResult.kept.map((draft) => toTransaction(draft, context.batchId));

  // ---- 4. Pair internal transfers ---------------------------------------
  const paired = pairInternalTransfers(transactions, context.pairing ?? {});
  transactions = paired.transactions;

  // ---- 5. Categorise cashflow rows --------------------------------------
  transactions = transactions.map((tx) =>
    isCategorisable(tx) ? categorizeTransaction(tx, context.rules) : { ...tx, categorySource: 'none' as const },
  );

  // ---- 6. Deduplicate ----------------------------------------------------
  // The fingerprint is the idempotency key. Checking against existing storage
  // AND against rows already seen in this batch keeps a double-submitted file
  // from changing a single total.
  const seen = new Set<string>(context.existingFingerprints ?? []);
  const fresh: Transaction[] = [];
  const duplicates: Transaction[] = [];

  for (const tx of transactions) {
    if (seen.has(tx.fingerprint)) {
      duplicates.push(tx);
      dropped.push({
        reason: 'duplicate',
        detail: 'Already imported (matching fingerprint); skipped to keep totals unchanged.',
        preview: preview({
          source: tx.source,
          occurredAt: tx.occurredAt,
          amountMinor: tx.amountMinor,
          direction: tx.direction,
          description: tx.rawDescription,
        } as DraftTransaction),
      });
      continue;
    }
    seen.add(tx.fingerprint);
    fresh.push(tx);
  }

  return { transactions: fresh, duplicates, dropped, pairs: paired.pairs, warnings };
}
