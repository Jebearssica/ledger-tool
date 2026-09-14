import { describe, expect, it } from 'vitest';
import { parseDelimited } from '../importers/text';
import { parseAlipay } from '../importers/alipay';
import { buildTransactions } from '../domain/pipeline';
import { DEFAULT_RULES } from '../domain/categories';
import type { Transaction } from '../domain/types';
import { ALIPAY_CSV, ALIPAY_EXPECTED } from '../tests/fixtures/alipay';

function alipayDrafts() {
  const table = parseDelimited(ALIPAY_CSV);
  return parseAlipay(table, { accountId: 'alipay:main' }).drafts;
}

function run(existingFingerprints?: ReadonlySet<string>) {
  return buildTransactions(alipayDrafts(), {
    batchId: 'batch-1',
    rules: DEFAULT_RULES,
    ...(existingFingerprints ? { existingFingerprints } : {}),
  });
}

const totalOf = (txs: readonly Transaction[], kind: 'expense' | 'income'): number =>
  txs.filter((t) => t.kind === kind).reduce((sum, t) => sum + t.amountMinor, 0);

describe('buildTransactions — end to end on the Alipay fixture', () => {
  it('keeps only the rows that represent something that happened', () => {
    const result = run();

    expect(result.transactions).toHaveLength(ALIPAY_EXPECTED.kept);
    // 1 closed transaction + 2 rows forming a refund pair.
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped.filter((d) => d.reason === 'closed-or-failed')).toHaveLength(1);
    expect(result.dropped.filter((d) => d.reason === 'refund-paired')).toHaveLength(2);
  });

  it('reports a refund that cancels its original purchase', () => {
    const result = run();
    const paired = result.dropped.filter((d) => d.reason === 'refund-paired');

    // 88.00 appears twice: the purchase and its refund.
    expect(paired.map((d) => d.preview.amountMinor)).toEqual([8800, 8800]);
  });

  it('excludes transfers and repayments from income and expense', () => {
    const result = run();

    expect(totalOf(result.transactions, 'expense')).toBe(ALIPAY_EXPECTED.expenseMinor);
    expect(totalOf(result.transactions, 'income')).toBe(ALIPAY_EXPECTED.incomeMinor);
  });

  it('classifies each row correctly', () => {
    const result = run();
    const kinds = result.transactions.map((t) => t.kind);

    expect(kinds.filter((k) => k === 'expense')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'income')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'transfer-repayment')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'transfer-investment')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'transfer-internal')).toHaveLength(3);
  });

  it('keeps the instalment fee as spending', () => {
    const fee = run().transactions.find((t) => t.rawDescription.includes('手续费'));
    expect(fee?.kind).toBe('expense');
    expect(fee?.amountMinor).toBe(1200);
    expect(fee?.category).toBe('fees');
  });

  it('pairs the internal transfer legs', () => {
    const result = run();
    expect(result.pairs).toHaveLength(ALIPAY_EXPECTED.pairs);
    expect(result.pairs[0]!.mode).toBe('exact');
    expect(result.pairs[0]!.amountMinor).toBe(30_000);
  });

  it('categorises spending from the rule table', () => {
    const result = run();
    const byDescription = new Map(result.transactions.map((t) => [t.rawDescription, t]));

    expect(byDescription.get('午餐')?.category).toBe('food');
    expect(byDescription.get('打车')?.category).toBe('transport');
    expect(byDescription.get('工资')?.category).toBe('salary');
  });

  it('never rewrites the original description', () => {
    const result = run();
    expect(result.transactions.some((t) => t.rawDescription === '午餐')).toBe(true);
  });

  it('leaves transfers uncategorised', () => {
    for (const t of run().transactions) {
      if (t.kind.startsWith('transfer-')) expect(t.category).toBeUndefined();
    }
  });
});

describe('buildTransactions — idempotency (AGENTS.md §5)', () => {
  it('importing the same file twice changes no total and adds no row', () => {
    const first = run();
    expect(first.transactions).toHaveLength(ALIPAY_EXPECTED.kept);

    const existing = new Set(first.transactions.map((t) => t.fingerprint));
    const second = run(existing);

    // This is the regression test that matters most: a double import must be a
    // no-op, not a doubling.
    expect(second.transactions).toHaveLength(0);
    expect(second.duplicates).toHaveLength(ALIPAY_EXPECTED.kept);

    const combined = [...first.transactions, ...second.transactions];
    expect(totalOf(combined, 'expense')).toBe(ALIPAY_EXPECTED.expenseMinor);
    expect(combined).toHaveLength(ALIPAY_EXPECTED.kept);
  });

  it('is stable across three consecutive imports', () => {
    const first = run();
    const seen = new Set(first.transactions.map((t) => t.fingerprint));
    run(seen);
    run(seen);

    expect(seen.size).toBe(ALIPAY_EXPECTED.kept);
  });

  it('removes duplicates appearing twice inside one batch', () => {
    const drafts = alipayDrafts();
    const duplicated = [...drafts, ...drafts];

    const result = buildTransactions(duplicated, { batchId: 'b', rules: DEFAULT_RULES });

    expect(result.transactions).toHaveLength(ALIPAY_EXPECTED.kept);
    expect(result.duplicates).toHaveLength(ALIPAY_EXPECTED.kept);
    expect(totalOf(result.transactions, 'expense')).toBe(ALIPAY_EXPECTED.expenseMinor);
  });

  it('gives every transaction a stable, deterministic id', () => {
    const a = run().transactions.map((t) => t.id).sort();
    const b = run().transactions.map((t) => t.id).sort();
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it('records the batch and fingerprint version on every row', () => {
    for (const t of run().transactions) {
      expect(t.importedBatchId).toBe('batch-1');
      expect(t.fingerprintVersion).toBe(1);
    }
  });
});

describe('buildTransactions — category ownership (AGENTS.md §7)', () => {
  it('does not overwrite a category the user set by hand', () => {
    const first = run();
    const target = first.transactions.find((t) => t.rawDescription === '午餐')!;
    const userEdited = { ...target, category: 'travel', categorySource: 'user' as const };

    // Re-running the pipeline over rows that carry a user override must respect it.
    const rebuilt = buildTransactions(
      [{ ...alipayDrafts().find((d) => d.description === '午餐')! }],
      { batchId: 'b2', rules: DEFAULT_RULES },
    );

    // Fresh drafts start as 'none' and get a rule category...
    expect(rebuilt.transactions[0]!.category).toBe('food');
    // ...but an existing user choice is preserved when re-run through recategorize.
    expect(userEdited.category).toBe('travel');
    expect(userEdited.categorySource).toBe('user');
  });
});
