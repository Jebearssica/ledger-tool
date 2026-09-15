import type { Transaction, TransactionKind } from '../domain/types';
import { formatMinor } from '../domain/money';

export const KIND_LABELS: Record<TransactionKind, string> = {
  expense: '支出',
  income: '收入',
  'transfer-internal': '内部转账',
  'transfer-investment': '投资转账',
  'transfer-repayment': '还款',
  refund: '退款',
  unknown: '未知',
};

export function kindLabel(kind: TransactionKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export function kindBadgeClass(kind: TransactionKind): string {
  if (kind === 'income') return 'badge income';
  if (kind === 'expense') return 'badge expense';
  if (kind === 'refund') return 'badge';
  return 'badge transfer';
}

/** Only real income and expense move the totals; transfers are excluded. */
export function isCashflow(tx: Transaction): boolean {
  return tx.kind === 'expense' || tx.kind === 'income';
}

export function amountClass(kind: TransactionKind): string {
  if (kind === 'income') return 'num amount income';
  if (kind === 'expense') return 'num amount expense';
  return 'num';
}

/**
 * Note for a purchase whose amount was reduced by a partial refund.
 *
 * Netting keeps the totals exact but hides that a refund ever happened, so the
 * deduction is spelled out wherever the row is shown. See AGENTS.md §5.
 */
export function refundNettedNote(meta?: Record<string, string>): string | null {
  const netted = Number(meta?.['refundNettedMinor'] ?? 0);
  if (!Number.isFinite(netted) || netted <= 0) return null;
  const stated = Number(meta?.['statedAmountMinor'] ?? 0);
  const from = Number.isFinite(stated) && stated > 0 ? `，原 ${formatMinor(stated)}` : '';
  return `已抵扣部分退款 ${formatMinor(netted)}${from}`;
}
