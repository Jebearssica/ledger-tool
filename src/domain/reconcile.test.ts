import { describe, expect, it } from 'vitest';
import type { Transaction } from './types';
import { describeChanges, reconcileOverlap } from './reconcile';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    // Not all digits on purpose: the privacy gate rejects any 16-19 digit run as a
    // possible card number, and it cannot tell a synthetic fingerprint from one.
    id: 'tx_0123456789abcdef',
    fingerprint: '0123456789abcdef',
    fingerprintVersion: 2,
    source: 'test',
    accountId: 'acc',
    direction: 'out',
    amountMinor: 15_400,
    currency: 'CNY',
    occurredAt: '2026-05-18T08:26:00.000Z',
    rawDescription: '示例商品',
    categorySource: 'rule',
    kind: 'expense',
    importedBatchId: 'batch-old',
    ...overrides,
  };
}

describe('reconcileOverlap', () => {
  it('reports nothing to do when the incoming row says the same thing', () => {
    // The idempotency guarantee depends on this: re-importing an unchanged file
    // must not rewrite every stored row, or provenance would churn on every run.
    expect(reconcileOverlap(tx(), tx())).toBeNull();
  });

  it('ignores which batch the row came from', () => {
    // `importedBatchId` is provenance stamped at save time, not content.
    expect(reconcileOverlap(tx(), tx({ importedBatchId: 'batch-new' }))).toBeNull();
  });

  it('corrects the amount, and says so', () => {
    const stored = tx();
    const incoming = tx({
      amountMinor: 14_500,
      importedBatchId: 'batch-new',
      meta: { refundNettedMinor: '900', statedAmountMinor: '15400' },
    });

    const result = reconcileOverlap(stored, incoming)!;

    expect(result).not.toBeNull();
    expect(result.before).toBe(stored);
    expect(result.after.amountMinor).toBe(14_500);
    expect(result.after.importedBatchId).toBe('batch-new');
    // Both netting figures are reported, not just the visible amount, so the user
    // can see that a refund was netted rather than the purchase simply shrinking.
    expect(result.changes).toEqual([
      'amount ¥154.00 -> ¥145.00',
      'refundNettedMinor (none) -> 900',
      'statedAmountMinor (none) -> 15400',
    ]);
  });

  it('corrects the kind, which is not part of the fingerprint', () => {
    // A classifier fix changes what a row means without changing which row it is.
    const result = reconcileOverlap(tx(), tx({ kind: 'transfer-internal' }))!;

    expect(result.changes).toContain('kind expense -> transfer-internal');
  });

  it('keeps the record’s own primary key, whatever it happens to be', () => {
    // The pipeline normally derives the id from the fingerprint, so this is a
    // no-op there. A record that arrived via a restored snapshot or an older
    // build may differ, and writing a different id would collide with the unique
    // fingerprint index and abort the whole import.
    const stored = tx({ id: 'tx_legacy_id' });
    const incoming = tx({ id: 'tx_0123456789abcdef', amountMinor: 14_500 });

    const result = reconcileOverlap(stored, incoming)!;

    expect(result.after.id).toBe('tx_legacy_id');
    expect(result.after.amountMinor).toBe(14_500);
  });

  it('keeps a category the user set by hand', () => {
    // AGENTS.md §7: a manual correction outranks anything the rule engine infers,
    // so a re-import must not silently undo it.
    const stored = tx({ category: '日用品', categorySource: 'user' });
    const incoming = tx({ category: '购物', categorySource: 'rule', amountMinor: 14_500 });

    const result = reconcileOverlap(stored, incoming)!;

    expect(result.after.category).toBe('日用品');
    expect(result.after.categorySource).toBe('user');
    // The amount is still corrected: preserving the category must not freeze the
    // rest of the row.
    expect(result.after.amountMinor).toBe(14_500);
  });

  it('does not report a category change when the user’s choice matches', () => {
    const stored = tx({ category: '日用品', categorySource: 'user' });
    const incoming = tx({ category: '日用品', categorySource: 'user' });

    expect(reconcileOverlap(stored, incoming)).toBeNull();
  });

  it('is insensitive to the order meta keys happen to sit in', () => {
    const stored = tx({ meta: { a: '1', b: '2' } });
    const incoming = tx({ meta: { b: '2', a: '1' } });

    expect(reconcileOverlap(stored, incoming)).toBeNull();
  });

  it('leaves the fingerprint-only preimage out of the change list', () => {
    // It is long, opaque, and equal by construction whenever fingerprints match.
    const result = reconcileOverlap(
      tx({ meta: { preimage: 'v2|ord|X|15400|out' } }),
      tx({ meta: { preimage: 'v2|ord|X|15400|out' }, kind: 'income' }),
    )!;

    expect(result.changes.some((c) => c.startsWith('preimage'))).toBe(false);
  });
});

describe('describeChanges', () => {
  it('says (none) rather than printing an empty string', () => {
    expect(describeChanges(tx({ category: undefined }), tx({ category: 'food' }))).toContain(
      'category (none) -> food',
    );
  });

  it('lists every field it can change', () => {
    const changes = describeChanges(
      tx({ category: 'a' }),
      tx({
        amountMinor: 1,
        kind: 'income',
        direction: 'in',
        category: 'b',
        occurredAt: '2026-05-19T00:00:00.000Z',
        counterparty: 'new',
        rawDescription: 'changed',
      }),
    );

    expect(changes).toHaveLength(7);
  });

  it('is empty when nothing differs', () => {
    expect(describeChanges(tx(), tx())).toEqual([]);
  });
});
