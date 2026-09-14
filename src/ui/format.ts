import type { Transaction, TransactionKind } from '../domain/types';

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
