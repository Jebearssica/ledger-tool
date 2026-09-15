import { describe, expect, it } from 'vitest';
import { parseDelimited } from '../importers/text';
import { parseAlipay } from '../importers/alipay';
import { buildTransactions } from '../domain/pipeline';
import { DEFAULT_RULES } from '../domain/categories';
import { FINGERPRINT_VERSION } from '../domain/fingerprint';
import type { Transaction } from '../domain/types';
import {
  ALIPAY_CSV,
  ALIPAY_EXPECTED,
  ALIPAY_REFUND_CSV,
  ALIPAY_REFUND_EXPECTED,
} from '../tests/fixtures/alipay';

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

/**
 * Refunds, in all four shapes they really take. See AGENTS.md §5.
 *
 * The regression this guards is specific and was found on a real statement:
 * requiring the refund's amount to equal the purchase's amount rejected every
 * PARTIAL refund — grocery substitutions refunding ¥0.11–¥1.25 against ¥39–¥48
 * orders — and reported each as "no matching purchase". The opposite mistake is
 * worse still: treating a partial refund as a full one erases the rest of a real
 * purchase from the totals.
 */
describe('buildTransactions — refunds (AGENTS.md §5)', () => {
  function runRefundFixture(existingFingerprints?: ReadonlySet<string>) {
    const table = parseDelimited(ALIPAY_REFUND_CSV);
    const drafts = parseAlipay(table, { accountId: 'alipay:main' }).drafts;
    return buildTransactions(drafts, {
      batchId: 'refund-batch',
      rules: DEFAULT_RULES,
      ...(existingFingerprints ? { existingFingerprints } : {}),
    });
  }

  it('nets a partial refund against its purchase instead of dropping it in whole', () => {
    const result = runRefundFixture();

    const purchase = result.transactions.find((t) => t.rawDescription === '示例生鲜订单')!;

    // 43.19 - 0.30, not 43.19 and not 0.00.
    expect(purchase.amountMinor).toBe(4289);
    expect(purchase.kind).toBe('expense');
    // The original text is never rewritten, and the adjustment is recorded.
    expect(purchase.rawDescription).toBe('示例生鲜订单');
    expect(purchase.meta?.['refundNettedMinor']).toBe('30');
    expect(purchase.meta?.['statedAmountMinor']).toBe('4319');
  });

  it('raises no warning about a partial refund', () => {
    const result = runRefundFixture();

    // The fixture holds exactly one genuinely orphaned refund, so exactly one
    // warning is expected — and it must NOT be about the partial refund.
    const unmatched = result.warnings.filter((w) => w.code === 'refund-unmatched');
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.message).toContain('202609080040');
    expect(result.dropped.filter((d) => d.reason === 'refund-partial')).toHaveLength(1);
  });

  it('leaves a partial refund out of the row list, so it cannot become income', () => {
    const result = runRefundFixture();
    expect(result.transactions.filter((t) => t.kind === 'refund')).toHaveLength(3);
    // Only the ¥0.30 refund was consumed; the other three refund rows stay.
    const refunds = result.transactions
      .filter((t) => t.kind === 'refund')
      .map((t) => t.amountMinor)
      .sort((a, b) => a - b);
    expect(refunds).toEqual([500, 1200, 15_950]);
  });

  it('keeps spending at the net figure and never lets it vanish', () => {
    const result = runRefundFixture();
    expect(result.transactions).toHaveLength(ALIPAY_REFUND_EXPECTED.kept);
    expect(totalOf(result.transactions, 'expense')).toBe(ALIPAY_REFUND_EXPECTED.expenseMinor);
    expect(totalOf(result.transactions, 'income')).toBe(ALIPAY_REFUND_EXPECTED.incomeMinor);
  });

  it('treats the reversal of a closed order as benign, not as an anomaly', () => {
    const result = runRefundFixture();

    // The purchase was dropped as 交易关闭 in stage 1…
    expect(result.dropped.filter((d) => d.reason === 'closed-or-failed')).toHaveLength(1);
    // …and its reversal is kept as a refund row without any complaint.
    expect(result.warnings.some((w) => w.message.includes('202609030020'))).toBe(false);
    expect(
      result.transactions.some((t) => t.amountMinor === 15_950 && t.kind === 'refund'),
    ).toBe(true);
  });

  it('never nets a refund larger than its purchase into a negative expense', () => {
    const result = runRefundFixture();

    // The over-refund's purchase (¥10.00) is cancelled outright…
    const cancelled = result.dropped.filter((d) => d.reason === 'refund-paired');
    expect(cancelled.map((d) => d.preview.amountMinor)).toEqual([1000]);
    // …and the unmatched excess is surfaced rather than guessed at.
    const warn = result.warnings.find((w) => w.code === 'refund-exceeds-purchase');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('2.00');
    // Crucially, no row was given a negative amount.
    expect(result.transactions.every((t) => t.amountMinor > 0)).toBe(true);
  });

  it('still warns about a refund whose purchase is genuinely absent', () => {
    const result = runRefundFixture();
    const unmatched = result.warnings.filter((w) => w.code === 'refund-unmatched');

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.message).toContain('202609080040');
  });

  it('stays idempotent when a refund was netted', () => {
    const first = runRefundFixture();
    const existing = new Set(first.transactions.map((t) => t.fingerprint));
    const second = runRefundFixture(existing);

    expect(second.transactions).toHaveLength(0);
    expect(second.duplicates).toHaveLength(ALIPAY_REFUND_EXPECTED.kept);
  });

  it('fingerprints a netted purchase by the amount printed on the statement', () => {
    // Two overlapping exports of one period must agree even when only one of them
    // carries the refund row: otherwise the purchase imports twice.
    const withRefund = runRefundFixture();
    const purchase = withRefund.transactions.find((t) => t.amountMinor === 4289)!;

    const table = parseDelimited(ALIPAY_REFUND_CSV);
    const withoutRefundRow = parseAlipay(table, { accountId: 'alipay:main' })
      .drafts.filter((d) => d.description !== '退款-示例生鲜订单');
    const plain = buildTransactions(withoutRefundRow, {
      batchId: 'refund-batch',
      rules: DEFAULT_RULES,
    });

    const sameInBoth = plain.transactions.find((t) => t.rawDescription === '示例生鲜订单')!;
    expect(sameInBoth.amountMinor).toBe(4319);
    expect(sameInBoth.fingerprint).toBe(purchase.fingerprint);
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
      expect(t.fingerprintVersion).toBe(FINGERPRINT_VERSION);
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
