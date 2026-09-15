import { describe, expect, it } from 'vitest';
import type { DraftTransaction } from '../domain/types';
import {
  classifyKind,
  disclosedPartialRefundMinor,
  isClosedOrFailed,
  isRefundRow,
  looksLikeTransfer,
} from '../domain/classify';

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

  it('does not read a precious-metal word in a MERCHANT name as an investment', () => {
    // Real one-year statement, ¥26.57: a shampoo filed under 美容美发, bought from
    // a merchant Alipay had masked as 黄金**半. Matching 黄金 against the
    // counterparty erased real spending from the totals. The row is a plain 支出,
    // so the platform flag is absent and the word must not be believed.
    expect(
      classifyKind(
        draft({
          direction: 'out',
          description: '惠润柔净洗发露护发素绿野芳香鲜花芳香600ml',
          counterparty: '黄金**半',
          txType: '美容美发',
          method: '建设银行储蓄卡(9574)',
          excludedFromCashflow: false,
        }),
      ),
    ).toBe('expense');
  });

  it('still reads a genuine precious-metal movement as an investment', () => {
    // These rows always carry the platform's own 不计收支 marker.
    for (const description of ['购买黄金', '积存金买入', '贵金属交易']) {
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

describe('classifyKind — interest credited as income', () => {
  it('counts daily wallet interest as income, not an investment transfer', () => {
    // Alipay files these under 交易分类 = 投资理财 and marks them 不计收支, so both
    // the investment rule and the "not cashflow" flag would discard them. They
    // are money actually gained, and a real year held 365 of them.
    expect(
      classifyKind(
        draft({
          direction: 'in',
          description: '余额宝-2026.09.13-收益发放',
          counterparty: '天弘基金管理有限公司',
          txType: '投资理财',
          excludedFromCashflow: true,
        }),
      ),
    ).toBe('income');
  });

  it('still treats an investment purchase as a transfer', () => {
    expect(
      classifyKind(
        draft({
          description: '蚂蚁财富-华泰柏瑞纳斯达克100ETF联接(QDII)A-买入',
          txType: '投资理财',
          excludedFromCashflow: true,
        }),
      ),
    ).toBe('transfer-investment');
  });

  it('does not read an outgoing interest/fee charge as income', () => {
    expect(
      classifyKind(
        draft({ direction: 'out', description: '利息', excludedFromCashflow: true }),
      ),
    ).toBe('expense');
  });
});

describe('isClosedOrFailed — real-world status wordings', () => {
  it('catches 还款失败, which a narrower list missed', () => {
    // Observed in a real statement. Missing it recorded a repayment that the
    // platform had explicitly marked as failed.
    expect(isClosedOrFailed(draft({ status: '还款失败' }))).toBe(true);
  });

  it('catches the other terminal states', () => {
    for (const status of ['交易关闭', '交易失败', '支付失败', '已取消', '已撤销', '交易超时', '已失效']) {
      expect(isClosedOrFailed(draft({ status }))).toBe(true);
    }
  });

  it('does not treat a successful or pending status as terminal', () => {
    for (const status of ['交易成功', '支付成功', '还款成功', '退款成功', '等待确认收货', '已存入零钱']) {
      expect(isClosedOrFailed(draft({ status }))).toBe(false);
    }
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

/**
 * WeChat discloses a refund on the purchase's own status rather than against a
 * linked order id, so the row has to be read carefully: `已退款…` on a purchase
 * means part of it came back, not that the row is a refund.
 */
describe('disclosedPartialRefundMinor — a refund the row discloses itself', () => {
  it('reads the figure from both spellings a real export uses', () => {
    // Real rows: the purchase read `已退款(¥9.00)`, its refund leg `已退款¥9.00`.
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '已退款(¥9.00)' }))).toBe(900);
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '已退款¥9.00' }))).toBe(900);
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '已退款(9.00)' }))).toBe(900);
  });

  it('names no figure when the whole purchase was reversed', () => {
    // `已全额退款` must stay on the refund path: netting it would keep a row that
    // is entirely cancelled, and there is no figure to net anyway.
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '已全额退款' }))).toBeNull();
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '退款成功' }))).toBeNull();
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '交易成功' }))).toBeNull();
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400 }))).toBeNull();
  });

  it('refuses a figure that is not smaller than the row', () => {
    // Equal means fully reversed, larger contradicts the statement. Either one
    // would invent spending that never happened.
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 900, status: '已退款¥9.00' }))).toBeNull();
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 500, status: '已退款¥9.00' }))).toBeNull();
  });

  it('is not fooled by parentheses that hold something other than money', () => {
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '退款(3天到账)' }))).toBeNull();
  });

  it('does not read a discount as a refund', () => {
    // 已优惠¥3.60 sits in 商品, but the guard must hold even if it ever reached 状态.
    expect(disclosedPartialRefundMinor(draft({ amountMinor: 15_400, status: '已优惠¥3.60' }))).toBeNull();
  });

  it('leaves a partially refunded purchase classified as a purchase', () => {
    const purchase = draft({
      direction: 'out',
      amountMinor: 15_400,
      status: '已退款(¥9.00)',
      txType: '商户消费',
      description: '示例商品',
    });
    // The trap: `已退款` alone made this a refund row, which discarded the row
    // and with it the ¥145.00 that really left the account.
    expect(isRefundRow(purchase)).toBe(false);
    expect(classifyKind(purchase)).toBe('expense');
  });

  it('still calls the refund leg and a fully reversed purchase refunds', () => {
    expect(isRefundRow(draft({ direction: 'in', amountMinor: 900, status: '已退款¥9.00' }))).toBe(true);
    expect(isRefundRow(draft({ amountMinor: 15_400, status: '已全额退款' }))).toBe(true);
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
