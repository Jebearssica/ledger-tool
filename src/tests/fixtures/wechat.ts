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

/**
 * The preamble of a real export, reproduced in SHAPE only — every value here is
 * fabricated. The blank rows are not padding: the real file skips rows 6 and 16,
 * which is why the header lands on the 18th row and why nothing may count lines
 * to find it (AGENTS.md §8.3 rule 1).
 */
const REAL_PREAMBLE: string[][] = [
  ['微信支付账单明细'],
  ['微信昵称：[synthetic]'],
  ['起始时间：[2026-09-01 00:00:00] 终止时间：[2026-09-30 23:59:59]'],
  ['导出类型：[全部账单]'],
  ['导出时间：[2026-10-01 09:00:00]'],
  [],
  ['共8笔记录'],
  ['收入：2笔 65.68元'],
  ['支出：4笔 176.80元'],
  ['中性交易：2笔 200.00元'],
  ['注：'],
  ['1. 充值/提现/理财通购买/零钱通存取/信用卡还款等交易，将计入中性交易'],
  ['2. 若交易记录明细无有效内容，则代表该时间段内此微信号无交易'],
  ['3. 本明细仅供个人对账使用'],
  ['4. 本账单中所有时间均为UTC+08:00时间'],
  [],
  ['----------------------微信支付账单明细列表--------------------'],
];

/**
 * The header exactly as the real XLSX export writes it: the amount column
 * carries its unit, `金额(元)`. Requiring the bare `金额` rejected every real
 * file with `Missing columns: 金额`.
 */
const REAL_HEADER = [
  '交易时间',
  '交易类型',
  '交易对方',
  '商品',
  '收/支',
  '金额(元)',
  '支付方式',
  '当前状态',
  '交易单号',
  '商户单号',
  '备注',
];

/** Index of the header row in the real-shaped sheet above (the 18th row). */
export const WECHAT_REAL_HEADER_INDEX = REAL_PREAMBLE.length;

/**
 * The real export's shape: a 17-row preamble, the `金额(元)` header, then the
 * same synthetic data rows as `WECHAT_XLSX_ROWS` — so the two spellings can be
 * compared directly.
 */
export const WECHAT_REAL_SHAPE_ROWS: string[][] = [
  ...REAL_PREAMBLE,
  REAL_HEADER,
  ...WECHAT_XLSX_ROWS.slice(5),
];
