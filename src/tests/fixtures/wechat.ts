/**
 * SYNTHETIC WeChat fixture. See AGENTS.md §3 rule 4.
 *
 * All values are fabricated. The `\t` characters are deliberate: WeChat
 * prefixes long order numbers with a tab so Excel keeps them as text, and the
 * importer must strip them before parsing (AGENTS.md §8.3 rule 2).
 *
 * The `¥` prefixes on amounts are also deliberate — the money parser must strip
 * them rather than fail (AGENTS.md §8.3 rule 3).
 */

/**
 * Header index in the PARSED table (blank lines are dropped, so it is 3 even
 * though the raw file has it on the 5th line). The XLSX-shaped rows below keep
 * their blank rows and therefore place it at index 4 — which is exactly why the
 * importer scans for the header instead of counting lines.
 */
export const WECHAT_HEADER_LINE_INDEX = 3;

/** Tab is injected before order ids exactly as the real export does. */
const T = '\t';

export const WECHAT_ROWS = {
  groceries: `2026-09-01 09:00:00,商户消费,示例超市,日用商品,支出,¥56.80,零钱,支付成功,${T}4200001111202609010001,,`,
  coffee: `2026-09-02 08:15:00,商户消费,星巴克咖啡,拿铁,支出,¥32.00,零钱通,支付成功,${T}4200001111202609020002,,`,
  transfer: `2026-09-03 10:00:00,转账,示例好友,/,/,¥200.00,零钱,已存入零钱,${T}4200001111202609030003,10001,`,
  cardRepayment: `2026-09-04 11:00:00,信用卡还款,示例银行,/,/,¥3000.00,零钱,还款成功,${T}4200001111202609040004,10002,`,
  /** Withdrawal with a service fee disclosed in 备注. */
  withdrawalWithFee: `2026-09-05 20:00:00,零钱提现,示例银行,/,/,¥500.00,零钱,提现已到账,${T}4200001111202609050005,10003,服务费 ¥0.50`,
  redPacket: `2026-09-06 12:00:00,微信红包,示例好友,微信红包,收入,¥8.88,零钱,已存入零钱,${T}4200001111202609060006,10004,`,
  dinner: `2026-09-07 19:30:00,商户消费,示例餐厅,晚餐,支出,¥88.00,零钱,支付成功,${T}4200001111202609070007,,`,
  /** Refund whose order id extends the original's id. */
  refund: `2026-09-08 09:00:00,退款,示例超市,日用商品,收入,¥56.80,零钱,已全额退款,${T}4200001111202609010001R01,10005,`,
};

export const WECHAT_CSV = [
  '微信支付账单明细',
  '微信昵称：[synthetic]',
  '起始时间：[2026-09-01 00:00:00] 终止时间：[2026-09-30 23:59:59]',
  '',
  '交易时间,交易类型,交易对方,商品,收/支,金额,支付方式,当前状态,交易单号,商户单号,备注',
  WECHAT_ROWS.groceries,
  WECHAT_ROWS.coffee,
  WECHAT_ROWS.transfer,
  WECHAT_ROWS.cardRepayment,
  WECHAT_ROWS.withdrawalWithFee,
  WECHAT_ROWS.redPacket,
  WECHAT_ROWS.dinner,
  WECHAT_ROWS.refund,
  '',
].join('\n');

/** The same rows as a table, which is what the XLSX path supplies (no tabs). */
const asXlsxRow = (csvRow: string): string[] =>
  csvRow.split(',').map((cell) => cell.replace(/\t/g, ''));

export const WECHAT_XLSX_ROWS: string[][] = [
  ['微信支付账单明细'],
  ['微信昵称：[synthetic]'],
  [],
  [],
  ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额', '支付方式', '当前状态', '交易单号', '商户单号', '备注'],
  asXlsxRow(WECHAT_ROWS.groceries),
  asXlsxRow(WECHAT_ROWS.coffee),
  asXlsxRow(WECHAT_ROWS.transfer),
  asXlsxRow(WECHAT_ROWS.cardRepayment),
  asXlsxRow(WECHAT_ROWS.withdrawalWithFee),
  asXlsxRow(WECHAT_ROWS.redPacket),
  asXlsxRow(WECHAT_ROWS.dinner),
  asXlsxRow(WECHAT_ROWS.refund),
];

export const WECHAT_EXPECTED = {
  rowsRead: 8,
  /**
   * 8 data rows. A refund cancels the grocery purchase, removing 2, leaving 6.
   * The withdrawal then splits into a principal plus its fee, giving 7.
   */
  kept: 7,
  /**
   * coffee 32.00 + dinner 88.00 + the 0.50 service fee = 120.50.
   *
   * The grocery expense is NOT counted: its refund cancelled it. And the
   * withdrawal principal is a transfer between the user's own accounts, so it
   * is not spending either.
   */
  expenseMinor: 12_050,
  /** The 8.88 red packet. The refund is a cancellation, not income. */
  incomeMinor: 888,
};
