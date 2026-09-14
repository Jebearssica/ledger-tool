import { describe, expect, it } from 'vitest';
import { parseDelimited } from './text';
import { parseAlipay } from './alipay';
import {
  ALIPAY_CSV,
  ALIPAY_HEADER_LINE_INDEX,
  ALIPAY_LEGACY_CSV,
  ALIPAY_ROWS,
} from '../tests/fixtures/alipay';

const parse = (csv: string) => parseAlipay(parseDelimited(csv), { accountId: 'alipay:main' });

describe('parseAlipay — header location', () => {
  it('scans for the header instead of hardcoding Alipay\'s usual ~23 lines', () => {
    // The fixture's preamble is deliberately 6 lines, so a hardcoded 23 would
    // read data as headers and produce nonsense.
    const table = parseDelimited(ALIPAY_CSV);
    expect(table.headerRowIndex).toBe(ALIPAY_HEADER_LINE_INDEX);
    expect(table.rows[table.headerRowIndex]![0]).toBe('交易时间');
  });

  it('reads every data row', () => {
    expect(parse(ALIPAY_CSV).drafts).toHaveLength(12);
  });

  it('reports the failed version rather than silently mis-reading columns', () => {
    expect(() => parse(ALIPAY_LEGACY_CSV)).toThrow(/OLD-FORMAT Alipay/i);
  });

  it('does not reject a current export merely because its title says 支付宝', () => {
    // Every Alipay export, current ones included, starts with 支付宝…
    expect(parse(ALIPAY_CSV).drafts.length).toBeGreaterThan(0);
  });

  it('refuses a file with no recognisable header at all', () => {
    expect(() => parse('a,b,c\n1,2,3')).toThrow(/could not find a header row/i);
  });

  it('names the missing columns when the layout is wrong', () => {
    const broken = [
      '交易时间,交易对方,商品说明',
      '2026-09-01 08:00:00,示例餐厅,午餐',
    ].join('\n');
    expect(() => parse(broken)).toThrow(/Missing columns: 收\/支, 金额/);
  });
});

describe('parseAlipay — row mapping', () => {
  const drafts = parse(ALIPAY_CSV).drafts;
  const byDescription = new Map(drafts.map((d) => [d.description, d]));

  it('converts amounts to integer minor units with no float involved', () => {
    expect(byDescription.get('午餐')?.amountMinor).toBe(2850);
    expect(byDescription.get('工资')?.amountMinor).toBe(1_200_000);
    for (const d of drafts) expect(Number.isInteger(d.amountMinor)).toBe(true);
  });

  it('maps 收入 and 支出 to directions', () => {
    expect(byDescription.get('午餐')?.direction).toBe('out');
    expect(byDescription.get('工资')?.direction).toBe('in');
  });

  it('flags 不计收支 rows as excluded from cashflow', () => {
    // The platform's own marker, trusted over keyword guessing.
    for (const description of ['转账', '转出', '收款', '花呗还款', '银证转账']) {
      expect(byDescription.get(description)?.excludedFromCashflow).toBe(true);
    }
    expect(byDescription.get('午餐')?.excludedFromCashflow).toBe(false);
  });

  it('infers a direction for 不计收支 rows from their wording', () => {
    // Alipay gives no direction on these rows; the guess only affects pairing.
    expect(byDescription.get('转出')?.direction).toBe('out');
    expect(byDescription.get('收款')?.direction).toBe('in');
  });

  it('carries the platform fields through for later stages', () => {
    const lunch = byDescription.get('午餐')!;
    expect(lunch.txType).toBe('餐饮美食');
    expect(lunch.method).toBe('余额');
    expect(lunch.status).toBe('交易成功');
    expect(lunch.orderId).toBe('2026090100001');
    expect(lunch.currency).toBe('CNY');
    expect(lunch.occurredAt).toBe('2026-09-01T00:12:33.000Z');
  });

  it('captures the refund status and order id needed for pairing', () => {
    const refund = byDescription.get('退款')!;
    expect(refund.status).toBe('退款成功');
    expect(refund.orderId).toBe('2026091000009R001');
    // The original's id is a prefix of the refund's id.
    expect(refund.orderId!.startsWith(byDescription.get('退款商品')!.orderId!)).toBe(true);
  });

  it('keeps the verbatim source fields for auditing', () => {
    expect(byDescription.get('午餐')?.raw['商品说明']).toBe('午餐');
    expect(byDescription.get('午餐')?.raw['交易订单号']).toBe('2026090100001');
  });

  it('never rewrites the original description', () => {
    expect(drafts.some((d) => d.description === ALIPAY_ROWS.expense.split(',')[4])).toBe(true);
  });
});

describe('parseAlipay — refusing to guess', () => {
  it('skips a row whose 收/支 value is unrecognised, and says so', () => {
    // A fourth value in a three-value column means the platform changed
    // something. Guessing would silently corrupt the totals.
    const csv = [
      '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号',
      '2026-09-01 08:00:00,餐饮美食,示例餐厅,午餐,未知方向,28.50,余额,交易成功,ORDER1,',
    ].join('\n');

    const result = parseAlipay(parseDelimited(csv), { accountId: 'alipay:main' });
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('unknown-direction-value');
  });

  it('skips a row with an unusable amount', () => {
    const csv = [
      '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号',
      '2026-09-01 08:00:00,餐饮美食,示例餐厅,午餐,支出,待确认,余额,交易成功,ORDER1,',
    ].join('\n');

    const result = parseAlipay(parseDelimited(csv), { accountId: 'alipay:main' });
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('unparsable-amount');
  });

  it('skips a row with an impossible date', () => {
    const csv = [
      '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号',
      '2026-02-31 08:00:00,餐饮美食,示例餐厅,午餐,支出,28.50,余额,交易成功,ORDER1,',
    ].join('\n');

    const result = parseAlipay(parseDelimited(csv), { accountId: 'alipay:main' });
    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('unparsable-date');
  });

  it('reports the total rows read in its metadata', () => {
    expect(parse(ALIPAY_CSV).meta.totalRows).toBe(12);
    expect(parse(ALIPAY_CSV).meta.sourceLabel).toBe('Alipay');
  });
});
