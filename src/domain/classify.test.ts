import { describe, expect, it } from 'vitest';
import type { DraftTransaction } from '../domain/types';
import { classifyKind, isClosedOrFailed, isRefundRow, looksLikeTransfer } from '../domain/classify';

function draft(overrides: Partial<DraftTransaction> = {}): DraftTransaction {
  return {
    source: 'test',
    accountId: 'acc',
    direction: 'out',
    amountMinor: 1000,
    currency: 'CNY',
    occurredAt: '2026-09-14T02:30:00.000Z',
    description: '',
    excludedFromCashflow: false,
    raw: {},
    ...overrides,
  };
}

describe('classifyKind — credit-line repayments (AGENTS.md §6.1)', () => {
  it('treats a Huabei PURCHASE as a real expense', () => {
    // The trap: keying on "花呗" would wrongly mark this a repayment and make
    // 45.00 of real spending disappear from the totals.
    expect(
      classifyKind(draft({ description: '打车', counterparty: '示例出行', method: '花呗' })),
    ).toBe('expense');
  });

  it('treats a Huabei REPAYMENT as a transfer, not spending', () => {
    expect(
      classifyKind(draft({ description: '花呗还款', excludedFromCashflow: true })),
    ).toBe('transfer-repayment');
  });

  it('recognises credit-card repayments, with and without the platform flag', () => {
    expect(classifyKind(draft({ description: '信用卡还款', excludedFromCashflow: true }))).toBe('transfer-repayment');
    // A bank statement shows the same repayment without any 不计收支 marker.
    expect(classifyKind(draft({ description: '信用卡自动还款', counterparty: '示例银行' }))).toBe('transfer-repayment');
  });

  it('covers the other credit lines', () => {
    for (const description of ['借呗还款', '京东白条还款', '花呗分期还款', '贷款结清']) {
      expect(classifyKind(draft({ description, excludedFromCashflow: true }))).toBe('transfer-repayment');
    }
  });

  it('keeps fees and interest as real expenses even on a repayment row', () => {
    // The documented exception: the fee is a genuine cost.
    for (const description of ['花呗分期手续费', '信用卡逾期费', '分期服务费', '利息', '违约金']) {
      expect(classifyKind(draft({ description, excludedFromCashflow: true }))).toBe('expense');
    }
  });
});

describe('classifyKind — investments (AGENTS.md §6)', () => {
  it('routes brokerage transfers out of cashflow', () => {
    for (const description of ['银证转账', '三方存管', '证券转入', '购买基金', '股票卖出']) {
      expect(classifyKind(draft({ description, excludedFromCashflow: true }))).toBe('transfer-investment');
    }
  });
});

describe('classifyKind — the platform flag is trusted', () => {
  it('treats an unflagged 不计收支 row as an internal transfer', () => {
    expect(classifyKind(draft({ description: '转入到余额宝', excludedFromCashflow: true }))).toBe('transfer-internal');
  });

  it('reads ordinary in/out rows as cashflow', () => {
    expect(classifyKind(draft({ direction: 'out', description: '午餐' }))).toBe('expense');
    expect(classifyKind(draft({ direction: 'in', description: '工资' }))).toBe('income');
  });

  it('does not treat a payment method as an investment', () => {
    // "理财" appears in 余额宝-style wallet names; a plain purchase must survive.
    expect(classifyKind(draft({ direction: 'out', description: '午餐', method: '余额' }))).toBe('expense');
  });
});

describe('isClosedOrFailed', () => {
  it('flags rows that never completed', () => {
    expect(isClosedOrFailed(draft({ status: '交易关闭' }))).toBe(true);
    expect(isClosedOrFailed(draft({ status: '交易失败' }))).toBe(true);
    expect(isClosedOrFailed(draft({ status: '已取消' }))).toBe(true);
    expect(isClosedOrFailed(draft({ status: '已撤销' }))).toBe(true);
  });

  it('does not flag successful rows', () => {
    expect(isClosedOrFailed(draft({ status: '交易成功' }))).toBe(false);
    expect(isClosedOrFailed(draft({ status: '支付成功' }))).toBe(false);
    expect(isClosedOrFailed(draft({ status: '已存入零钱' }))).toBe(false);
    expect(isClosedOrFailed(draft({ status: '提现已到账' }))).toBe(false);
  });
});

describe('isRefundRow', () => {
  it('recognises Alipay refund rows by status and category', () => {
    expect(isRefundRow(draft({ status: '退款成功', txType: '退款' }))).toBe(true);
    expect(isRefundRow(draft({ status: '退款成功' }))).toBe(true);
    expect(isRefundRow(draft({ txType: '退款' }))).toBe(true);
  });

  it('does not treat ordinary purchases as refunds', () => {
    expect(isRefundRow(draft({ status: '交易成功', txType: '购物' }))).toBe(false);
  });
});

describe('looksLikeTransfer', () => {
  it('accepts platform-flagged rows and transfer wording', () => {
    expect(looksLikeTransfer(draft({ excludedFromCashflow: true }))).toBe(true);
    expect(looksLikeTransfer(draft({ description: '转账到银行卡' }))).toBe(true);
    expect(looksLikeTransfer(draft({ description: '零钱提现' }))).toBe(true);
  });

  it('rejects ordinary spending', () => {
    expect(looksLikeTransfer(draft({ description: '午餐', counterparty: '示例餐厅' }))).toBe(false);
  });
});
