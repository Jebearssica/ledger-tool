/**
 * The import pipeline: drafts → persisted transactions.
 *
 * Stage order matters and is not arbitrary:
 *
 *   1. drop impossible rows   (a closed transaction never happened)
 *   2. pair refunds           (needs orderId + amount, so must precede hashing)
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
import { classifyKind, isClosedOrFailed, isRefundRow } from './classify';
import { fingerprintPreimage, fingerprint, transactionIdFromFingerprint, FINGERPRINT_VERSION } from './fingerprint';
import { pairInternalTransfers, type PairingOptions, type TransferPair } from './transfers';

export type DropReason = 'closed-or-failed' | 'refund-paired' | 'duplicate';

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
 * Refunds are not income.
 *
 * Alipay records a refund as its own row: `交易状态 = 退款成功`, `交易分类 = 退款`.
 * If it is left in, the original purchase counts as an expense AND the refund
 * counts as income, so both sides are overstated by the same amount. Matching
 * them and removing both is the only correct outcome.
 *
 * Matching rule (AGENTS.md §5): the refund's order id has the original's order
 * id as a prefix, and the amounts are equal.
 */
function pairRefunds(drafts: readonly DraftTransaction[]): {
  kept: DraftTransaction[];
  dropped: DroppedRow[];
  warnings: ParseWarning[];
} {
  const dropped: DroppedRow[] = [];
  const warnings: ParseWarning[] = [];
  const removed = new Set<number>();

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
      if (candidate.amountMinor !== refund.amountMinor) return false;
      const candidateOrderId = candidate.orderId ?? '';
      if (candidateOrderId === '') return false;
      return refundOrderId.startsWith(candidateOrderId);
    });

    if (originalIndex === -1) {
      warnings.push({
        code: 'refund-unmatched',
        message: `Refund (order ${refundOrderId.slice(0, 12)}…) has no matching purchase in this import. It is kept as "refund" and excluded from totals.`,
      });
      return;
    }

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
      preview: preview(drafts[originalIndex]!),
    });
  });

  return {
    kept: drafts.filter((_, i) => !removed.has(i)),
    dropped,
    warnings,
  };
}

function toTransaction(draft: DraftTransaction, batchId: string): Transaction {
  const kind = isRefundRow(draft) ? 'refund' : classifyKind(draft);

  const fpInput = {
    occurredAt: draft.occurredAt,
    amountMinor: draft.amountMinor,
    direction: draft.direction,
    counterparty: draft.counterparty,
    balanceAfterMinor: draft.balanceAfterMinor,
  };

  const fp = fingerprint(fpInput);

  const meta: Record<string, string> = {};
  if (draft.txType) meta['txType'] = draft.txType;
  if (draft.method) meta['method'] = draft.method;
  if (draft.status) meta['status'] = draft.status;
  if (draft.orderId) meta['orderId'] = draft.orderId;
  if (draft.merchantOrderId) meta['merchantOrderId'] = draft.merchantOrderId;
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
  for (const draft of drafts) {
    if (isClosedOrFailed(draft)) {
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
  const refundResult = pairRefunds(live);
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
