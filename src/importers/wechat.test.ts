import { describe, expect, it } from 'vitest';
import { findHeaderRowIndex, parseDelimited, type Table } from './text';
import { extractFeeMinor, parseWechat } from './wechat';
import type { DraftTransaction } from '../domain/types';
import {
  WECHAT_CSV,
  WECHAT_HEADER_LINE_INDEX,
  WECHAT_REAL_HEADER_INDEX,
  WECHAT_REAL_SHAPE_ROWS,
  WECHAT_XLSX_ROWS,
} from '../tests/fixtures/wechat';

const parseCsv = () =>
  parseWechat(parseDelimited(WECHAT_CSV, { stripTabs: true }), { accountId: 'wechat:main' });

const asTable = (rows: readonly string[][], headerRowIndex: number): Table => ({
  rows: rows.map((row) => row.map((c) => c.trim())),
  delimiter: '(xlsx)',
  headerRowIndex,
  notes: [],
});

const parseXlsxShaped = () =>
  parseWechat(asTable(WECHAT_XLSX_ROWS, 4), { accountId: 'wechat:main', format: 'xlsx' });

/** The layout a real export actually has: long preamble plus a `金额(元)` header. */
const parseRealShape = () =>
  parseWechat(asTable(WECHAT_REAL_SHAPE_ROWS, WECHAT_REAL_HEADER_INDEX), {
    accountId: 'wechat:main',
    format: 'xlsx',
  });

/** Everything that must not differ between the two amount-column spellings. */
const comparable = (drafts: readonly DraftTransaction[]) =>
  drafts.map((d) => ({
    description: d.description,
    amountMinor: d.amountMinor,
    direction: d.direction,
    occurredAt: d.occurredAt,
    txType: d.txType,
    status: d.status,
    orderId: d.orderId,
    merchantOrderId: d.merchantOrderId,
    counterparty: d.counterparty,
    excludedFromCashflow: d.excludedFromCashflow,
  }));

describe('parseWechat — header location', () => {
  it('finds the header in the CSV', () => {
    const table = parseDelimited(WECHAT_CSV, { stripTabs: true });
    expect(table.headerRowIndex).toBe(WECHAT_HEADER_LINE_INDEX);
  });

  it('reads every data row', () => {
    expect(parseCsv().drafts.length).toBeGreaterThanOrEqual(8);
  });

  it('does not reject a file merely because its title says 微信', () => {
    expect(parseCsv().drafts.length).toBeGreaterThan(0);
  });

  it('names the missing columns when the layout is wrong', () => {
    const broken = ['交易时间,交易对方,商品', '2026-09-01 08:00:00,示例超市,日用'].join('\n');
    expect(() => parseWechat(parseDelimited(broken), { accountId: 'w' })).toThrow(/Missing columns: 收\/支, 金额/);
  });
});

describe('parseWechat — real export layout', () => {
  it('finds the header below a preamble the length of a real one', () => {
    // Nothing may count lines: the real header is on the 18th row, and the row
    // count has changed between platform releases.
    expect(findHeaderRowIndex(WECHAT_REAL_SHAPE_ROWS, '交易时间')).toBe(WECHAT_REAL_HEADER_INDEX);
  });

  it('accepts the 金额(元) header that real exports use', () => {
    // Regression: requiring the bare `金额` rejected the file outright with
    // "Missing columns: 金额" and no rows imported at all.
    expect(parseRealShape().drafts.length).toBeGreaterThanOrEqual(8);
  });

  it('reads the same drafts from 金额(元) as from 金额', () => {
    // The unit suffix is part of the column title, not part of the data; it must
    // change nothing but the key the raw row is filed under.
    expect(comparable(parseRealShape().drafts)).toEqual(comparable(parseXlsxShaped().drafts));
  });

  it('keeps the header text as written in raw', () => {
    const draft = parseRealShape().drafts[0]!;
    expect(draft.raw['金额(元)']).toBeDefined();
    expect(draft.raw['金额']).toBeUndefined();
  });

  it('does not let 金额 match an unrelated column', () => {
    // `交易金额` is a different column, and a prefix match would silently read
    // the wrong numbers out of it.
    const rows = [
      ['交易时间', '收/支', '交易金额'],
      ['2026-09-01 09:00:00', '支出', '56.80'],
    ];
    expect(() => parseWechat(asTable(rows, 0), { accountId: 'w' })).toThrow(/Missing columns: 金额/);
  });
});

describe('parseWechat — the export quirks from AGENTS.md §8.3', () => {
  it('strips the tabs WeChat injects, so order ids stay intact', () => {
    // A leftover tab would end up inside the order id, and — more dangerously —
    // could make the file look tab-separated.
    const orderId = parseCsv().drafts.find((d) => d.orderId?.startsWith('4200001111202609010001'))?.orderId;
    expect(orderId).toBe('4200001111202609010001');
    expect(orderId).not.toContain('\t');
  });

  it('still reads the file as comma-separated despite the injected tabs', () => {
    // This is the real hazard: one tab per row must not outweigh ten commas and
    // convince the sniffer that this is a TSV, which would destroy every column.
    expect(parseDelimited(WECHAT_CSV).delimiter).toBe(',');
    expect(parseDelimited(WECHAT_CSV, { stripTabs: true }).delimiter).toBe(',');
  });

  it('refuses to strip tabs from a genuinely tab-separated file', () => {
    // Doing so would remove the column boundaries themselves.
    const tsv = '交易时间\t金额\n2026-09-01\t28.50';
    expect(() => parseDelimited(tsv, { stripTabs: true, delimiter: '\t' })).toThrow(/destroy the column boundaries/i);
  });

  it('strips the ¥ prefix from amounts', () => {
    const groceries = parseCsv().drafts.find((d) => d.description.includes('日用商品'));
    expect(groceries?.amountMinor).toBe(5680);
  });

  it('reads the same amounts from the XLSX shape as from the CSV', () => {
    const fromCsv = parseCsv().drafts.map((d) => [d.description, d.amountMinor]);
    const fromXlsx = parseXlsxShaped().drafts.map((d) => [d.description, d.amountMinor]);
    expect(fromXlsx).toEqual(fromCsv);
  });

  it('treats 收/支 = "/" as excluded from cashflow', () => {
    const transfer = parseCsv().drafts.find((d) => d.txType === '转账')!;
    expect(transfer.excludedFromCashflow).toBe(true);
    expect(transfer.direction).toBe('out');
  });

  it('maps 收入 and 支出 normally', () => {
    const packet = parseCsv().drafts.find((d) => d.description.includes('微信红包'))!;
    expect(packet.direction).toBe('in');
    expect(packet.excludedFromCashflow).toBe(false);
  });
});

describe('parseWechat — service fee split (AGENTS.md §6.1)', () => {
  it('extracts a fee from 备注', () => {
    expect(extractFeeMinor('服务费 ¥0.50')).toBe(50);
    expect(extractFeeMinor('手续费：1.20')).toBe(120);
    expect(extractFeeMinor('利息 3.00')).toBe(300);
  });

  it('does not invent a fee when 备注 has none', () => {
    expect(extractFeeMinor('')).toBeNull();
    expect(extractFeeMinor('普通备注')).toBeNull();
    expect(extractFeeMinor('服务费待定')).toBeNull();
  });

  it('splits a withdrawal into principal plus fee', () => {
    const drafts = parseCsv().drafts;
    const principal = drafts.find((d) => d.amountMinor === 49_950);
    const fee = drafts.find((d) => d.amountMinor === 50 && d.description.includes('服务费'));

    expect(principal).toBeDefined();
    expect(fee).toBeDefined();
    // The withdrawal itself is a transfer, not spending…
    expect(principal!.excludedFromCashflow).toBe(true);
    // …but the fee is genuine spending.
    expect(fee!.excludedFromCashflow).toBe(false);
    expect(fee!.direction).toBe('out');
  });

  it('conserves the total when splitting', () => {
    // (principal − fee) + fee === principal, so a mis-firing regex can change
    // the categorisation but can never invent or lose money.
    const drafts = parseCsv().drafts;
    const principal = drafts.find((d) => d.raw['金额'] === '¥500.00' && d.amountMinor === 49_950)!;
    const fee = drafts.find((d) => d.raw['金额'] === '¥500.00' && d.amountMinor === 50)!;
    expect(principal.amountMinor + fee.amountMinor).toBe(50_000);
  });
});
