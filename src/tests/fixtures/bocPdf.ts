/**
 * Synthetic fixture for the verified Bank-of-China debit-card PDF layout
 * (AGENTS.md §8.4 / §8.2).
 *
 * Fully fabricated, as §3 rule 4 requires: no real statement, name, card number
 * or amount appears here. What IS real is the GEOMETRY — the column x positions,
 * the widths the generator assigns, and the way it emits padded cells, wrapped
 * cells and its own printed footer. Those are what the rebuild has to get right,
 * and they are facts about the format, not about the user's money.
 *
 * The layout reproduces the three traps the real file contained:
 *
 *   1. every cell is padded so that column edges are flush, so gap-based cell
 *      splitting sees no gaps at all;
 *   2. a long 附言 wraps onto a second visual line, and the generator merges the
 *      padding of the empty 网点名称 cell into the SAME glyph run as the 附言;
 *   3. the page ends with an `END` marker and a footer note that are not rows.
 */
import type { PositionedTextItem } from '../../importers/pdf';

interface FakeColumn {
  header: string;
  /** Left edge of the header cell, in PDF points. */
  x: number;
  width: number;
  /** Where the cell's VALUES are anchored. Statements right-align figures. */
  align: 'left' | 'right';
}

/** Header cell positions and value alignment of the verified layout. */
const COLUMNS: readonly FakeColumn[] = [
  { header: '记账日期', x: 46, width: 36, align: 'left' },
  { header: '记账时间', x: 108.5, width: 36, align: 'left' },
  { header: '币别', x: 173.5, width: 18, align: 'left' },
  { header: '金额', x: 232.5, width: 18, align: 'right' },
  { header: '余额', x: 296.5, width: 18, align: 'right' },
  { header: '交易名称', x: 347.5, width: 36, align: 'left' },
  { header: '渠道', x: 410, width: 18, align: 'left' },
  { header: '网点名称', x: 463, width: 36, align: 'left' },
  { header: '附言', x: 545.5, width: 18, align: 'left' },
  { header: '对方账户名', x: 606, width: 45, align: 'left' },
  { header: '对方卡号/账号', x: 671.75, width: 58.5, align: 'left' },
  { header: '对方开户行', x: 756, width: 45, align: 'left' },
];

/** Left edge of each value slot: figures are right-aligned to a fixed edge. */
const VALUE_LAYOUT = [
  { x: 46, align: 'left' },
  { x: 112.5, align: 'left' },
  { x: 172, align: 'left' },
  { x: 277, align: 'right' },
  { x: 338, align: 'right' },
  { x: 344.5, align: 'left' },
  { x: 405, align: 'left' },
  { x: 446, align: 'left' },
  { x: 540.5, align: 'left' },
  { x: 593.5, align: 'left' },
  { x: 667.8, align: 'left' },
  { x: 740, align: 'left' },
] as const;

const DATE_COLUMN = 0;
const TIME_COLUMN = 1;
const CURRENCY_COLUMN = 2;
const AMOUNT_COLUMN = 3;
const BALANCE_COLUMN = 4;
const TYPE_COLUMN = 5;
const CHANNEL_COLUMN = 6;
const BRANCH_COLUMN = 7;
/** Left edge of the empty 网点名称 cell's padding run. */
const FILLER_X = 447.75;
const NOTE_COLUMN = 8;
const COUNTERPARTY_COLUMN = 9;
const ACCOUNT_COLUMN = 10;
const BANK_COLUMN = 11;

/** Row pitch and header position of the verified layout. */
export const BOC_HEADER_Y = 454.47;
export const BOC_FIRST_ROW_Y = 441.03;
export const BOC_ROW_PITCH = 18;

function charWidth(text: string): number {
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80) total += 9;
    else if (ch === ',' || ch === '.' || ch === '-' || ch === ' ') total += 2.5;
    else if (ch === ':') total += 2.75;
    else total += 5;
  }
  return total;
}

function run(text: string, x: number, y: number, width = charWidth(text)): PositionedTextItem {
  return { text, x, y, width };
}

function cell(index: number, text: string, y: number): PositionedTextItem {
  const layout = VALUE_LAYOUT[index]!;
  const width = charWidth(text);
  const x = layout.align === 'right' ? layout.x - width : layout.x;
  return run(text, x, y, width);
}

export interface BocRow {
  date: string;
  time: string;
  /** Signed, thousands-separated, as printed: `-1,234.56`. */
  amount: string;
  balance: string;
  txType: string;
  method: string;
  branch?: string;
  note?: string;
  counterparty?: string;
  account?: string;
  bank?: string;
  /**
   * A 附言 so long that the generator wraps it AND folds the empty 网点名称
   * cell's padding into the first line's glyph run. This is the shape that
   * silently misplaced a merchant into the wrong column.
   */
  wrapped?: { paddingThenNote: string; wrap: string };
}

/** The header line: one run per column, at the verified positions. */
export function bocHeaderItems(y: number): PositionedTextItem[] {
  return COLUMNS.map((column) => run(column.header, column.x, y, column.width));
}

export const BOC_HEADER_CELLS: string[] = COLUMNS.map((column) => column.header);

/** The lines a page prints above the table: title, filters, its own totals. */
function pageFurniture(pageNumber: number, pageCount: number, debit: string, credit: string): PositionedTextItem[] {
  return [
    run('示例银行交易流水明细清单', 283.5, 543.38, 240),
    run('交易区间： 2025-09-16', 32, 508.47, 95),
    run('至 2026-09-15', 134, 508.47, 56),
    run('客户姓名： 示例用户', 204, 508.47, 76),
    run('页数:', 573, 508.47, 22.5),
    run(String(pageNumber), 607.25, 508.47, 4.5),
    run(`/ ${pageCount}`, 618.75, 508.47, 15.25),
    run('账号： 000000000000', 32, 475.47, 84),
    run('借方发生数：', 204, 492.47, 54),
    run(debit, 266, 492.47, 45),
    run(`贷方发生数： ${credit}`, 366, 492.47, 104),
    run('行数:', 573, 492.47, 22.5),
    run(String(15), 605, 492.47, 9),
    run('打印时间： 2026/09/15 17:32:15', 573, 475.47, 134.5),
  ];
}

/** The lines a page prints below the table. None of these are transactions. */
function pageFooter(lastLineY: number): PositionedTextItem[] {
  return [
    // The real export prints END one row pitch plus a few points below the last
    // row — close enough to look like a wrap if the gap is not checked.
    run('--------------------END--------------------', 308.5, lastLineY - 21.75, 225),
    run('温馨提示: 1.记账日期/时间为系统进行记账处理的日期/时间,可能与实际交易提交时间存在差异。', 20, 32.6, 400),
    run('第 1 页/共 15 页', 366, 9.7, 60),
  ];
}

/** Expand one logical transaction row into the glyph runs a page would carry. */
function rowItems(row: BocRow, y: number): PositionedTextItem[] {
  const items = [
    cell(DATE_COLUMN, row.date, y),
    cell(TIME_COLUMN, row.time, y),
    cell(CURRENCY_COLUMN, '人民币', y),
    cell(AMOUNT_COLUMN, row.amount, y),
    cell(BALANCE_COLUMN, row.balance, y),
    cell(TYPE_COLUMN, row.txType, y),
    cell(CHANNEL_COLUMN, row.method, y),
  ];

  if (row.wrapped) {
    // 网点名称 is empty, so its padding is printed INSIDE the 附言's glyph run.
    const merged = `${'-'.repeat(19)} ${row.wrapped.paddingThenNote}`;
    items.push(run(merged, FILLER_X, y, charWidth(merged)));
    items.push(cell(NOTE_COLUMN, row.wrapped.wrap, y - 8));
  } else {
    if (row.branch) items.push(cell(BRANCH_COLUMN, row.branch, y));
    else items.push(run('-'.repeat(19), FILLER_X, y, charWidth('-'.repeat(19))));
    if (row.note) items.push(cell(NOTE_COLUMN, row.note, y));
    else items.push(run('-'.repeat(10), 537, y, charWidth('-'.repeat(10))));
  }

  if (row.counterparty) items.push(cell(COUNTERPARTY_COLUMN, row.counterparty, y));
  if (row.account) items.push(cell(ACCOUNT_COLUMN, row.account, y));
  if (row.bank) items.push(cell(BANK_COLUMN, row.bank, y));
  return items;
}

/**
 * Build one page's glyph runs. Deliberately NOT emitted in reading order, so the
 * rebuild has to sort by y and x like it does for a real content stream.
 */
export function bocPageItems(rows: readonly BocRow[], pageNumber: number, pageCount: number, debit: string, credit: string): PositionedTextItem[] {
  const lastRowY = BOC_FIRST_ROW_Y - (rows.length - 1) * BOC_ROW_PITCH;
  const lastLineY = rows.some((row) => row.wrapped) && rows[rows.length - 1]?.wrapped ? lastRowY - 8 : lastRowY;
  const items = [
    ...pageFurniture(pageNumber, pageCount, debit, credit),
    ...pageFooter(lastLineY),
    ...bocHeaderItems(BOC_HEADER_Y),
  ];
  rows.forEach((row, i) => {
    items.push(...rowItems(row, BOC_FIRST_ROW_Y - i * BOC_ROW_PITCH));
  });
  return items;
}

/** Sum of the signed amounts a statement would print as its own page totals. */
export function bocPrintedTotals(rows: readonly BocRow[]): { debit: string; credit: string } {
  let debit = 0;
  let credit = 0;
  for (const row of rows) {
    const minor = Math.round(Number(row.amount.replace(/,/g, '')) * 100);
    if (minor < 0) debit -= minor;
    else credit += minor;
  }
  return {
    debit: (debit / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }),
    credit: (credit / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }),
  };
}

/** Two pages, so the repeated header and the page boundary are both exercised. */
export const BOC_FIXTURE_ROWS: readonly (readonly BocRow[])[] = [
  [
    {
      date: '2026-09-10',
      time: '22:20:56',
      amount: '111.79',
      balance: '5,861.13',
      txType: '网上快捷退款',
      method: '银企对接',
      wrapped: { paddingThenNote: '示例商户甲', wrap: '(上海)有限公司' },
      counterparty: '示例商户甲',
      account: 'Z20079A00010N',
    },
    {
      date: '2026-09-04',
      time: '13:22:13',
      amount: '-1,244.00',
      balance: '5,749.13',
      txType: '网上快捷支付',
      method: '银企对接',
      note: '示例商户乙',
      counterparty: '示例商户乙',
      account: 'Z20049B00010N',
    },
    {
      date: '2026-08-05',
      time: '08:46:56',
      amount: '-380,000.00',
      balance: '6,799.54',
      txType: '银证转账',
      method: '其他',
      counterparty: '示例证券股份有限公司',
      account: '446859B13696',
      bank: '示例市分行',
    },
    {
      date: '2026-08-04',
      time: '14:31:06',
      amount: '6,960.00',
      balance: '181,054.61',
      txType: '小额普通',
      method: '柜台',
      branch: '示例银行示例支行',
      note: '柜面提取',
      counterparty: '示例公积金管理中心',
      account: '1202021C900080988',
      bank: '示例银行股份有限公司示例支行',
    },
  ],
  [
    {
      date: '2026-07-23',
      time: '13:39:55',
      amount: '20,000.00',
      balance: '35,452.16',
      txType: '跨行转账',
      method: '网上银行',
      note: '手机转账',
      counterparty: '示例用户',
      account: '62D4180002089281',
      bank: '示例银行股份有限公司',
    },
    {
      date: '2026-06-20',
      time: '22:53:00',
      amount: '1.86',
      balance: '7,520.96',
      txType: '结息',
      method: '其他',
    },
  ],
];

/** Every page's glyph runs, in page order. */
export function bocFixturePages(): PositionedTextItem[][] {
  return BOC_FIXTURE_ROWS.map((rows, i) => {
    const totals = bocPrintedTotals(rows);
    return bocPageItems(rows, i + 1, BOC_FIXTURE_ROWS.length, totals.debit, totals.credit);
  });
}
