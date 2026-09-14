import { describe, expect, it } from 'vitest';
import { parseGeneric } from './generic';
import { validateTemplate, type Template } from './template';
import { detectHeaderRowIndex, parseDelimited, type Table } from './text';

/** Bank-style statement: separate credit/debit columns plus a running balance. */
const TWO_COLUMN_CSV = [
  '交易日期,摘要,对方户名,收入,支出,余额',
  '2026-09-01,工资,示例公司,12000.00,,12000.00',
  '2026-09-02,午餐,示例餐厅,,28.50,11971.50',
  '2026-09-03,缴费,示例电力,,120.00,11851.50',
].join('\n');

/** Credit-card style: one signed amount column plus a direction flag. */
const SIGNED_CSV = [
  '交易日期,交易描述,交易金额,借/贷',
  '2026-09-01,示例超市,56.80,借',
  '2026-09-02,退款,56.80,贷',
  '2026-09-03,示例餐厅,32.00,借',
].join('\n');

const twoColumnTemplate: Template = {
  id: 'test-two-column@2026-09',
  label: 'Test two column',
  columns: {
    date: '交易日期',
    income: '收入',
    expense: '支出',
    balance: '余额',
    counterparty: '对方户名',
    description: '摘要',
  },
  amountMode: 'positive-is-expense',
};

const signedTemplate: Template = {
  id: 'test-signed@2026-09',
  label: 'Test signed',
  columns: { date: '交易日期', amount: '交易金额', direction: '借/贷', description: '交易描述' },
  amountMode: 'signed',
};

/**
 * Maps only the columns the small inline fixtures actually have. A template must
 * describe the file it is used with: mapping a column that is absent is an error,
 * by design.
 */
const minimalTemplate: Template = {
  id: 'test-two-min@2026-09',
  label: 'Test two column minimal',
  columns: { date: '交易日期', income: '收入', expense: '支出', description: '摘要' },
  amountMode: 'positive-is-expense',
};

function tableOf(csv: string): Table {
  const rows = parseDelimited(csv).rows;
  return { rows, delimiter: ',', headerRowIndex: detectHeaderRowIndex(rows), notes: [] };
}

describe('validateTemplate', () => {
  it('accepts a template whose columns all exist', () => {
    const result = validateTemplate(twoColumnTemplate, parseDelimited(TWO_COLUMN_CSV).rows[0]!);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('lists the columns that are absent from the file', () => {
    const header = ['交易日期', '摘要'];
    const result = validateTemplate(twoColumnTemplate, header);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['收入', '支出', '余额', '对方户名']);
  });

  it('rejects a template that maps no amount source at all', () => {
    const result = validateTemplate(
      { id: 'x', label: 'x', columns: { date: '交易日期' } },
      ['交易日期'],
    );
    expect(result.ok).toBe(false);
    expect(result.noAmountSource).toBe(true);
  });
});

describe('parseGeneric — missing columns', () => {
  it('refuses to parse when a mapped column is absent', () => {
    // Parsing anyway would assign amounts to the wrong columns, which is the
    // "plausible but wrong" failure the spec explicitly forbids.
    const table = tableOf('交易日期,摘要\n2026-09-01,午餐');
    expect(() => parseGeneric(table, twoColumnTemplate, { accountId: 'bank:main' })).toThrow(
      /does not match the expected layout/i,
    );
  });

  it('names the offending columns', () => {
    const table = tableOf('交易日期,摘要\n2026-09-01,午餐');
    expect(() => parseGeneric(table, twoColumnTemplate, { accountId: 'bank:main' })).toThrow(/Missing columns: 收入/);
  });

  it('complains when the template has no amount source', () => {
    const table = tableOf('交易日期,摘要\n2026-09-01,午餐');
    expect(() =>
      parseGeneric(table, { id: 'x', label: 'NoAmount', columns: { date: '交易日期' } }, { accountId: 'a' }),
    ).toThrow(/maps no amount source/i);
  });
});

describe('parseGeneric — two-column statements', () => {
  const drafts = parseGeneric(tableOf(TWO_COLUMN_CSV), twoColumnTemplate, { accountId: 'bank:main' }).drafts;

  it('reads income and expense sides into the right direction', () => {
    const salary = drafts.find((d) => d.description === '工资')!;
    const lunch = drafts.find((d) => d.description === '午餐')!;

    expect(salary.direction).toBe('in');
    expect(salary.amountMinor).toBe(1_200_000);
    expect(lunch.direction).toBe('out');
    expect(lunch.amountMinor).toBe(2850);
  });

  it('always produces positive amounts, with direction carrying the sign', () => {
    for (const d of drafts) expect(d.amountMinor).toBeGreaterThan(0);
  });

  it('captures the running balance, which strengthens the fingerprint', () => {
    expect(drafts.find((d) => d.description === '午餐')?.balanceAfterMinor).toBe(1_197_150);
  });

  it('skips rows where neither side carries a value', () => {
    const csv = ['交易日期,摘要,收入,支出', '2026-09-01,只有摘要,,'].join('\n');
    const result = parseGeneric(tableOf(csv), minimalTemplate, { accountId: 'a' });
    expect(result.drafts).toHaveLength(0);
  });

  it('refuses an ambiguous row instead of guessing which side it is', () => {
    const csv = ['交易日期,摘要,收入,支出', '2026-09-01,两边都有,10.00,20.00'].join('\n');
    const result = parseGeneric(tableOf(csv), minimalTemplate, { accountId: 'a' });

    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('ambiguous-both-sides');
  });
});

describe('parseGeneric — signed statements with a direction flag', () => {
  const drafts = parseGeneric(tableOf(SIGNED_CSV), signedTemplate, { accountId: 'card:main' }).drafts;

  it('honours the direction column over the sign', () => {
    expect(drafts.find((d) => d.description === '示例超市')!.direction).toBe('out');
    expect(drafts.find((d) => d.description === '退款')!.direction).toBe('in');
  });

  it('still parses positive amounts from a credit-card export', () => {
    // Credit-card statements print charges as positive figures; only the 借/贷
    // flag says which way the money went.
    for (const d of drafts) expect(d.amountMinor).toBeGreaterThan(0);
    expect(drafts.find((d) => d.description === '示例餐厅')!.amountMinor).toBe(3200);
  });

  it('falls back to the sign when the flag is unrecognised, and warns', () => {
    const csv = ['交易日期,交易描述,交易金额,借/贷', '2026-09-01,示例超市,-56.80,未知'].join('\n');
    const result = parseGeneric(tableOf(csv), signedTemplate, { accountId: 'a' });

    expect(result.warnings.map((w) => w.code)).toContain('unknown-direction-value');
    expect(result.drafts[0]!.direction).toBe('out');
    expect(result.drafts[0]!.amountMinor).toBe(5680);
  });

  it('treats a 不计收支 marker as excluded, inferring the direction from text', () => {
    const csv = ['交易日期,交易描述,交易金额,借/贷', '2026-09-01,转账到支付宝,500.00,不计收支'].join('\n');
    const result = parseGeneric(tableOf(csv), signedTemplate, { accountId: 'a' });

    expect(result.drafts[0]!.excludedFromCashflow).toBe(true);
    expect(result.drafts[0]!.direction).toBe('out');
  });
});

describe('parseGeneric — refusal cases', () => {
  it('skips rows with an impossible date', () => {
    const csv = ['交易日期,摘要,收入,支出', '2026-02-31,午餐,,28.50'].join('\n');
    const result = parseGeneric(tableOf(csv), minimalTemplate, { accountId: 'a' });

    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('unparsable-date');
  });

  it('skips rows with an unusable amount', () => {
    const csv = ['交易日期,摘要,收入,支出', '2026-09-01,午餐,,待定'].join('\n');
    const result = parseGeneric(tableOf(csv), minimalTemplate, { accountId: 'a' });

    expect(result.drafts).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain('unparsable-amount');
  });

  it('reports the template id so a pinned version is traceable', () => {
    const result = parseGeneric(tableOf(TWO_COLUMN_CSV), twoColumnTemplate, { accountId: 'a' });
    expect(result.meta.templateId).toBe('test-two-column@2026-09');
  });

  it('lets the source be overridden independently of the template id', () => {
    const result = parseGeneric(tableOf(TWO_COLUMN_CSV), twoColumnTemplate, {
      accountId: 'a',
      source: 'cmb:debit',
    });
    expect(result.drafts[0]!.source).toBe('cmb:debit');
  });
});
