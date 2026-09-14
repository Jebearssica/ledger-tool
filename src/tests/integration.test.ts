/**
 * End-to-end tests through the importer facade, starting from raw bytes.
 *
 * These are the tests that catch integration mistakes the unit tests cannot:
 * encoding detection, archive unwrapping, platform routing and the pipeline all
 * exercised together.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { inspectFile, parseInspected } from '../importers/index';
import { buildTransactions } from '../domain/pipeline';
import { DEFAULT_RULES } from '../domain/categories';
import { ALIPAY_CSV, ALIPAY_EXPECTED } from './fixtures/alipay';
import { WECHAT_CSV, WECHAT_EXPECTED } from './fixtures/wechat';
import type { Transaction } from '../domain/types';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const totalOf = (txs: readonly Transaction[], kind: 'expense' | 'income'): number =>
  txs.filter((t) => t.kind === kind).reduce((sum, t) => sum + t.amountMinor, 0);

/** Run the whole path: bytes -> inspection -> parse -> pipeline. */
async function importText(fileName: string, text: string, accountId = 'test:main') {
  const inspection = await inspectFile({ fileName, bytes: bytesOf(text) });
  const parsed = parseInspected(inspection, { accountId });
  const outcome = buildTransactions(parsed.drafts, { batchId: 'b1', rules: DEFAULT_RULES });
  return { inspection, parsed, outcome };
}

describe('inspectFile — recognition', () => {
  it('recognises an Alipay export from its headers', async () => {
    const inspection = await inspectFile({ fileName: 'alipay.csv', bytes: bytesOf(ALIPAY_CSV) });
    expect(inspection.detectedPlatform).toBe('alipay');
    expect(inspection.container).toBe('text');
  });

  it('recognises a WeChat export from its headers', async () => {
    const inspection = await inspectFile({ fileName: 'wechat.csv', bytes: bytesOf(WECHAT_CSV) });
    expect(inspection.detectedPlatform).toBe('wechat');
  });

  it('does not rely on the file extension', async () => {
    // Brokerages routinely ship TSV or HTML inside a file named .xls.
    const inspection = await inspectFile({ fileName: 'statement.xls', bytes: bytesOf(ALIPAY_CSV) });
    expect(inspection.detectedPlatform).toBe('alipay');
  });

  it('reports how it reached its conclusion', async () => {
    const inspection = await inspectFile({ fileName: 'alipay.csv', bytes: bytesOf(ALIPAY_CSV) });
    expect(inspection.steps.length).toBeGreaterThan(0);
    expect(inspection.steps.join(' ')).toMatch(/Detected text/);
  });

  it('leaves an unrecognised bank file for the generic mapper', async () => {
    const bankish = ['交易日期,摘要,收入,支出', '2026-09-01,午餐,,28.50'].join('\n');
    const inspection = await inspectFile({ fileName: 'bank.csv', bytes: bytesOf(bankish) });
    expect(inspection.detectedPlatform).toBeNull();
  });

  it('rejects an empty file', async () => {
    await expect(inspectFile({ fileName: 'empty.csv', bytes: new Uint8Array(0) })).rejects.toThrow(/empty/i);
  });

  it('explains itself when a legacy binary .xls is supplied', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    await expect(inspectFile({ fileName: 'legacy.xls', bytes: ole })).rejects.toThrow(/legacy Excel binary/i);
  });
});

describe('inspectFile — archives and other containers', () => {
  it('unwraps a zip and uses the statement inside', async () => {
    // Both Alipay and WeChat deliver their export as a zip by default.
    const archive = zipSync({
      '说明.txt': strToU8('这是一个合成测试文件。'),
      '微信支付账单.csv': strToU8(WECHAT_CSV),
    });

    const inspection = await inspectFile({ fileName: 'statement.zip', bytes: archive });

    expect(inspection.fileName).toBe('微信支付账单.csv');
    expect(inspection.detectedPlatform).toBe('wechat');
    expect(inspection.steps.join(' ')).toMatch(/Unwrapped archive/i);
  });

  it('prefers the statement over a readme', async () => {
    const archive = zipSync({
      'readme.txt': strToU8('README'),
      'alipay_record.csv': strToU8(ALIPAY_CSV),
    });
    const inspection = await inspectFile({ fileName: 'x.zip', bytes: archive });
    expect(inspection.detectedPlatform).toBe('alipay');
  });

  it('parses an HTML table, which some brokers ship as .xls', async () => {
    const html = [
      '<html><body><table>',
      '<tr><th>交易日期</th><th>摘要</th><th>收入</th><th>支出</th></tr>',
      '<tr><td>2026-09-01</td><td>午餐</td><td></td><td>28.50</td></tr>',
      '</table></body></html>',
    ].join('');

    const inspection = await inspectFile({ fileName: 'weird.xls', bytes: bytesOf(html) });
    expect(inspection.container).toBe('html');
    expect(inspection.table.rows.length).toBe(2);
  });

  it('reports an archive with nothing readable inside', async () => {
    const archive = zipSync({ 'notes.md': strToU8('# nothing') });
    await expect(inspectFile({ fileName: 'x.zip', bytes: archive })).rejects.toThrow(/no file this tool can read/i);
  });
});

describe('full path — Alipay', () => {
  it('produces the expected totals', async () => {
    const { outcome } = await importText('alipay.csv', ALIPAY_CSV);

    expect(outcome.transactions).toHaveLength(ALIPAY_EXPECTED.kept);
    expect(totalOf(outcome.transactions, 'expense')).toBe(ALIPAY_EXPECTED.expenseMinor);
    expect(totalOf(outcome.transactions, 'income')).toBe(ALIPAY_EXPECTED.incomeMinor);
  });

  it('is idempotent across two full imports', async () => {
    const first = await importText('alipay.csv', ALIPAY_CSV);
    const existing = new Set(first.outcome.transactions.map((t) => t.fingerprint));

    const inspection = await inspectFile({ fileName: 'alipay.csv', bytes: bytesOf(ALIPAY_CSV) });
    const parsed = parseInspected(inspection, { accountId: 'test:main' });
    const second = buildTransactions(parsed.drafts, {
      batchId: 'b2',
      rules: DEFAULT_RULES,
      existingFingerprints: existing,
    });

    expect(second.transactions).toHaveLength(0);
    expect(second.duplicates).toHaveLength(ALIPAY_EXPECTED.kept);
  });

  it('is unaffected by the file being inside a zip from the platform', async () => {
    const archive = zipSync({ 'alipay_record.csv': strToU8(ALIPAY_CSV) });
    const inspection = await inspectFile({ fileName: 'alipay.zip', bytes: archive });
    const parsed = parseInspected(inspection, { accountId: 'test:main' });
    const outcome = buildTransactions(parsed.drafts, { batchId: 'b1', rules: DEFAULT_RULES });

    expect(totalOf(outcome.transactions, 'expense')).toBe(ALIPAY_EXPECTED.expenseMinor);
  });
});

describe('full path — WeChat', () => {
  it('produces the expected totals', async () => {
    const { outcome } = await importText('wechat.csv', WECHAT_CSV);

    expect(outcome.transactions).toHaveLength(WECHAT_EXPECTED.kept);
    expect(totalOf(outcome.transactions, 'expense')).toBe(WECHAT_EXPECTED.expenseMinor);
    expect(totalOf(outcome.transactions, 'income')).toBe(WECHAT_EXPECTED.incomeMinor);
  });

  it('does not double count the service fee', async () => {
    const { outcome } = await importText('wechat.csv', WECHAT_CSV);

    // The withdrawal itself is a transfer between the user's own accounts…
    const withdrawal = outcome.transactions.find((t) => t.amountMinor === 49_950);
    expect(withdrawal?.kind).toBe('transfer-internal');

    // …and only its 0.50 fee is spending. Crucially the principal must NOT be
    // reclassified as a fee just because 备注 mentioned one.
    const fee = outcome.transactions.find((t) => t.amountMinor === 50);
    expect(fee?.kind).toBe('expense');
    expect(fee?.category).toBe('fees');

    // Together they still account for the original 500.00.
    expect((withdrawal?.amountMinor ?? 0) + (fee?.amountMinor ?? 0)).toBe(50_000);
  });

  it('cancels the refund against its purchase', async () => {
    const { outcome } = await importText('wechat.csv', WECHAT_CSV);
    const groceries = outcome.transactions.find((t) => t.rawDescription.includes('日用商品'));
    expect(groceries).toBeUndefined();
    expect(outcome.dropped.filter((d) => d.reason === 'refund-paired')).toHaveLength(2);
  });
});

describe('full path — a bank file driven by a template', () => {
  const bankCsv = [
    '交易日期,摘要,对方户名,收入,支出,余额',
    '2026-09-01,工资,示例公司,12000.00,,12000.00',
    '2026-09-02,午餐,示例餐厅,,28.50,11971.50',
    '2026-09-03,转出到支付宝,示例支付宝,,500.00,11471.50',
    '2026-09-03,转入,示例支付宝,500.00,,11971.50',
  ].join('\n');

  const template = {
    id: 'test-bank@2026-09',
    label: 'Test bank',
    columns: {
      date: '交易日期',
      income: '收入',
      expense: '支出',
      balance: '余额',
      counterparty: '对方户名',
      description: '摘要',
    },
    amountMode: 'positive-is-expense' as const,
  };

  it('needs a template, and says so when none is supplied', async () => {
    const inspection = await inspectFile({ fileName: 'bank.csv', bytes: bytesOf(bankCsv) });
    expect(() => parseInspected(inspection, { accountId: 'bank:main' })).toThrow(/column mapping is needed/i);
  });

  it('parses and totals correctly once a template is supplied', async () => {
    const inspection = await inspectFile({ fileName: 'bank.csv', bytes: bytesOf(bankCsv) });
    const parsed = parseInspected(inspection, { accountId: 'bank:main', template });
    const outcome = buildTransactions(parsed.drafts, { batchId: 'b1', rules: DEFAULT_RULES });

    expect(outcome.transactions).toHaveLength(4);
    expect(totalOf(outcome.transactions, 'income')).toBe(1_200_000);
    expect(totalOf(outcome.transactions, 'expense')).toBe(2850);
  });

  it('removes a bank ↔ wallet transfer from cashflow by pairing both legs', async () => {
    // "转出到支付宝" and "转入" must not appear as an expense plus an income.
    const inspection = await inspectFile({ fileName: 'bank.csv', bytes: bytesOf(bankCsv) });
    const parsed = parseInspected(inspection, { accountId: 'bank:main', template });
    const outcome = buildTransactions(parsed.drafts, { batchId: 'b1', rules: DEFAULT_RULES });

    expect(outcome.pairs).toHaveLength(1);
    expect(totalOf(outcome.transactions, 'expense')).toBe(2850); // lunch only
    expect(totalOf(outcome.transactions, 'income')).toBe(1_200_000); // salary only
    expect(outcome.transactions.filter((t) => t.kind === 'transfer-internal')).toHaveLength(2);
  });
});
