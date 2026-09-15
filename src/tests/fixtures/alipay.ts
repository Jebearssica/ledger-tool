/**
 * SYNTHETIC Alipay fixture. See AGENTS.md §3 rule 4.
 *
 * Every value here is fabricated: merchant names are 示例… ("example…") and all
 * addresses use the reserved `.test` TLD. No real statement, screenshot or
 * export was used, and none may ever be added to this file.
 *
 * The preamble is deliberately 6 lines rather than Alipay's usual ~23. That is
 * the point: it proves the importer locates the header by scanning for
 * `交易时间` instead of hardcoding a line number (AGENTS.md §8.3 rule 1).
 */

/**
 * Line index of the header in the parsed table.
 *
 * The raw file has the header on its 7th line, but blank lines are dropped
 * during parsing, so the table index is 4. Either way it is nowhere near the ~23
 * lines a real export usually has — which is the point: a hardcoded 23 would
 * read data rows as headers and produce nonsense.
 */
export const ALIPAY_HEADER_LINE_INDEX = 4;

export const ALIPAY_ROWS = {
  /** Ordinary expense, categorised by the seeded rules. */
  expense: '2026-09-01 08:12:33,餐饮美食,示例餐厅,shop@example.test,午餐,支出,28.50,余额,交易成功,2026090100001,',
  /** Expense paid with Huabei — still a real expense, not a repayment. */
  huabeiPurchase: '2026-09-02 12:30:00,交通出行,示例出行,ride@example.test,打车,支出,45.00,花呗,交易成功,2026090200002,',
  /** 不计收支, unpaired: an internal transfer with no counterpart in this file. */
  transferOutUnpaired: '2026-09-03 09:00:00,转账,示例好友,friend@example.test,转账,不计收支,200.00,余额,交易成功,2026090300003,',
  /** A matched pair of internal-transfer legs, both inside this one export. */
  transferOutPaired: '2026-09-05 20:00:00,转账,示例好友,friend@example.test,转出,不计收支,300.00,余额,交易成功,2026090500004,',
  transferInPaired: '2026-09-05 21:30:00,转账,示例好友,friend@example.test,收款,不计收支,300.00,余额,交易成功,2026090500005,',
  /** Repaying Huabei is not new spending. */
  huabeiRepayment: '2026-09-06 10:00:00,信用还款,示例花呗,huabei@example.test,花呗还款,不计收支,1500.00,余额,交易成功,2026090600006,',
  /** …but an instalment fee is. Must stay an expense despite 不计收支. */
  instalmentFee: '2026-09-07 11:00:00,信用还款,示例花呗,huabei@example.test,花呗分期手续费,不计收支,12.00,余额,交易成功,2026090700007,',
  /** Brokerage transfer: recorded separately, never in cashflow. */
  brokerageTransfer: '2026-09-08 14:00:00,投资理财,示例证券,broker@example.test,银证转账,不计收支,5000.00,余额,交易成功,2026090800008,',
  /** The purchase that the refund below cancels. */
  refundedPurchase: '2026-09-10 15:00:00,购物,示例商店,shop2@example.test,退款商品,支出,88.00,余额,交易成功,2026091000009,',
  /** Refund: order id carries the original's id as a prefix. */
  refund: '2026-09-12 15:00:00,退款,示例商店,shop2@example.test,退款,不计收支,88.00,余额,退款成功,2026091000009R001,',
  /** Never happened, so it must not be recorded. */
  closed: '2026-09-15 16:00:00,购物,示例商店,shop3@example.test,已取消订单,支出,66.00,余额,交易关闭,2026091500011,',
  /** Real income. */
  salary: '2026-09-20 09:00:00,转账,示例公司,corp@example.test,工资,收入,12000.00,余额,交易成功,2026092000012,',
};

export const ALIPAY_CSV = [
  '支付宝交易记录明细查询',
  '账号:[synthetic@example.test]',
  '起始日期:[2026-09-01 00:00:00]    终止日期:[2026-09-30 23:59:59]',
  '',
  '---------------------------------交易记录明细列表------------------------------------',
  '',
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号',
  ALIPAY_ROWS.expense,
  ALIPAY_ROWS.huabeiPurchase,
  ALIPAY_ROWS.transferOutUnpaired,
  ALIPAY_ROWS.transferOutPaired,
  ALIPAY_ROWS.transferInPaired,
  ALIPAY_ROWS.huabeiRepayment,
  ALIPAY_ROWS.instalmentFee,
  ALIPAY_ROWS.brokerageTransfer,
  ALIPAY_ROWS.refundedPurchase,
  ALIPAY_ROWS.refund,
  ALIPAY_ROWS.closed,
  ALIPAY_ROWS.salary,
  '',
].join('\n');

/** Expected numbers, derived by hand and asserted across several tests. */
export const ALIPAY_EXPECTED = {
  /** 12 data rows are read; 3 are then excluded (1 closed, 2 for a refund pair). */
  rowsRead: 12,
  kept: 9,
  /** 28.50 + 45.00 + 12.00 — the fee is an expense, the repayment is not. */
  expenseMinor: 8550,
  incomeMinor: 1_200_000,
  /** Two legs of one internal transfer. */
  pairs: 1,
};

/** A file with Alipay's old column layout, which must be refused outright. */
export const ALIPAY_LEGACY_CSV = [
  '支付宝交易记录明细查询',
  '交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态',
  '2026090100001,,2026-09-01 08:12:33,,,,,示例餐厅,午餐,28.50,支出,交易成功,,,,',
].join('\n');

/**
 * SYNTHETIC fixture for the four ways a refund can relate to its purchase.
 *
 * Cash flow cannot tell these apart, which is why each one is asserted on
 * separately (AGENTS.md §5):
 *
 *   partial   refund < purchase, so only a difference came back
 *   cancelled refund of an order the platform then marked 交易关闭
 *   overshoot refund larger than the purchase it claims to reverse
 *   orphan    refund whose purchase is not in this file at all
 */
export const ALIPAY_REFUND_ROWS = {
  /** Order 2026090200100, ¥43.19 — groceries, of which ¥0.30 came back. */
  partialPurchase:
    '2026-09-02 12:00:00,餐饮美食,示例生鲜,shop@example.test,示例生鲜订单,支出,43.19,余额宝,交易成功,2026090200100,',
  /** Same order id + a suffix, smaller amount: must NOT be read as unmatched. */
  partialRefund:
    '2026-09-02 12:05:00,退款,示例生鲜,shop@example.test,退款-示例生鲜订单,不计收支,0.30,余额宝,退款成功,2026090200100R001,',
  /** Never settled, so it never became spending… */
  cancelledPurchase:
    '2026-09-03 10:00:00,交通出行,示例铁路,rail@example.test,示例车票,支出,159.50,余额,交易关闭,2026090300200,',
  /** …and this row merely reverses that failed payment. Benign, not a warning. */
  cancelledRefund:
    '2026-09-05 10:00:00,退款,示例铁路,rail@example.test,退款-示例车票,不计收支,159.50,余额,退款成功,2026090300200M001,',
  /** A small purchase… */
  smallPurchase:
    '2026-09-06 10:00:00,购物,示例商店,shop2@example.test,示例小商品,支出,10.00,余额,交易成功,2026090600300,',
  /** …with a refund larger than it. Netting would invent a negative expense. */
  overRefund:
    '2026-09-07 10:00:00,退款,示例商店,shop2@example.test,退款-示例小商品,不计收支,12.00,余额,退款成功,2026090600300R001,',
  /** No purchase carrying this order id appears anywhere in the file. */
  orphanRefund:
    '2026-09-08 10:00:00,退款,示例商户,other@example.test,退款-外部订单,不计收支,5.00,余额,退款成功,2026090800400,',
};

export const ALIPAY_REFUND_CSV = [
  '支付宝交易记录明细查询',
  '账号:[synthetic@example.test]',
  '起始日期:[2026-09-01 00:00:00]    终止日期:[2026-09-30 23:59:59]',
  '',
  '---------------------------------交易记录明细列表------------------------------------',
  '',
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号',
  ALIPAY_REFUND_ROWS.partialPurchase,
  ALIPAY_REFUND_ROWS.partialRefund,
  ALIPAY_REFUND_ROWS.cancelledPurchase,
  ALIPAY_REFUND_ROWS.cancelledRefund,
  ALIPAY_REFUND_ROWS.smallPurchase,
  ALIPAY_REFUND_ROWS.overRefund,
  ALIPAY_REFUND_ROWS.orphanRefund,
  '',
].join('\n');

export const ALIPAY_REFUND_EXPECTED = {
  rowsRead: 7,
  /** 43.19 − 0.30, the cancelled refund, the over-refund and the orphan. */
  kept: 4,
  /** The ¥0.30 difference is subtracted from real spending, not from nothing. */
  expenseMinor: 4289,
  incomeMinor: 0,
};
