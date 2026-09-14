import { describe, expect, it } from 'vitest';
import type { Direction, Transaction } from '../domain/types';
import { isPairingCandidate, pairInternalTransfers } from '../domain/transfers';
import { fingerprint } from '../domain/fingerprint';

let counter = 0;

function tx(overrides: Partial<Transaction> & { direction: Direction; amountMinor: number; occurredAt: string }): Transaction {
  counter += 1;
  const id = `t${counter}`;
  return {
    id,
    fingerprint: fingerprint({
      occurredAt: overrides.occurredAt,
      amountMinor: overrides.amountMinor,
      direction: overrides.direction,
      counterparty: overrides.counterparty,
      balanceAfterMinor: overrides.balanceAfterMinor,
    }),
    fingerprintVersion: 1,
    source: 'alipay',
    accountId: 'alipay:main',
    currency: 'CNY',
    rawDescription: '',
    categorySource: 'none',
    kind: 'expense',
    importedBatchId: 'b1',
    ...overrides,
  } as Transaction;
}

describe('isPairingCandidate', () => {
  it('never re-pairs investments or repayments', () => {
    expect(isPairingCandidate(tx({ direction: 'out', amountMinor: 100, occurredAt: '2026-09-14T02:00:00.000Z', kind: 'transfer-investment' }))).toBe(false);
    expect(isPairingCandidate(tx({ direction: 'out', amountMinor: 100, occurredAt: '2026-09-14T02:00:00.000Z', kind: 'transfer-repayment' }))).toBe(false);
    expect(isPairingCandidate(tx({ direction: 'out', amountMinor: 100, occurredAt: '2026-09-14T02:00:00.000Z', kind: 'refund' }))).toBe(false);
  });

  it('accepts already-flagged rows and rows with transfer wording', () => {
    expect(isPairingCandidate(tx({ direction: 'out', amountMinor: 100, occurredAt: '2026-09-14T02:00:00.000Z', kind: 'transfer-internal' }))).toBe(true);
    expect(isPairingCandidate(tx({ direction: 'out', amountMinor: 100, occurredAt: '2026-09-14T02:00:00.000Z', rawDescription: '转账到余额宝' }))).toBe(true);
  });

  it('rejects ordinary spending', () => {
    expect(isPairingCandidate(tx({ direction: 'out', amountMinor: 100, occurredAt: '2026-09-14T02:00:00.000Z', rawDescription: '午餐' }))).toBe(false);
  });
});

describe('pairInternalTransfers — one to one', () => {
  it('pairs equal and opposite legs and pulls them out of cashflow', () => {
    const out = tx({ direction: 'out', amountMinor: 30_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal', rawDescription: '转出' });
    const inc = tx({ direction: 'in', amountMinor: 30_000, occurredAt: '2026-09-05T13:30:00.000Z', kind: 'transfer-internal', rawDescription: '收款' });

    const result = pairInternalTransfers([out, inc]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.mode).toBe('exact');
    expect(result.pairs[0]!.outIds).toEqual([out.id]);
    expect(result.pairs[0]!.inIds).toEqual([inc.id]);
    for (const t of result.transactions) expect(t.kind).toBe('transfer-internal');
  });

  it('reclassifies an unflagged expense/income pair', () => {
    // A bank "转出" with no platform flag lands as an expense; its twin lands as
    // income. Both must be recognised as one internal transfer.
    const out = tx({ direction: 'out', amountMinor: 50_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'expense', rawDescription: '转出到支付宝' });
    const inc = tx({ direction: 'in', amountMinor: 50_000, occurredAt: '2026-09-05T12:10:00.000Z', kind: 'income', rawDescription: '转入' });

    const result = pairInternalTransfers([out, inc]);
    expect(result.pairs).toHaveLength(1);
    expect(result.transactions.map((t) => t.kind)).toEqual(['transfer-internal', 'transfer-internal']);
  });

  it('does not pair amounts that differ', () => {
    const out = tx({ direction: 'out', amountMinor: 30_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal' });
    const inc = tx({ direction: 'in', amountMinor: 29_999, occurredAt: '2026-09-05T13:30:00.000Z', kind: 'transfer-internal' });

    expect(pairInternalTransfers([out, inc]).pairs).toHaveLength(0);
  });

  it('does not pair beyond the time window', () => {
    const out = tx({ direction: 'out', amountMinor: 30_000, occurredAt: '2026-09-01T12:00:00.000Z', kind: 'transfer-internal' });
    const inc = tx({ direction: 'in', amountMinor: 30_000, occurredAt: '2026-09-10T12:00:00.000Z', kind: 'transfer-internal' });

    expect(pairInternalTransfers([out, inc], { windowDays: 3 }).pairs).toHaveLength(0);
    expect(pairInternalTransfers([out, inc], { windowDays: 30 }).pairs).toHaveLength(1);
  });

  it('pairs within a single account, which is the common real case', () => {
    // Both legs of a 余额 → 余额宝 move appear in one Alipay export under the
    // same account, so requiring different accounts would defeat the feature.
    const out = tx({ direction: 'out', amountMinor: 10_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal', rawDescription: '转出到余额宝' });
    const inc = tx({ direction: 'in', amountMinor: 10_000, occurredAt: '2026-09-05T12:00:05.000Z', kind: 'transfer-internal', rawDescription: '余额宝转入' });
    expect(out.accountId).toBe(inc.accountId);

    expect(pairInternalTransfers([out, inc]).pairs).toHaveLength(1);
  });

  it('chooses the closest leg in time when several match', () => {
    const out = tx({ direction: 'out', amountMinor: 10_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal' });
    const near = tx({ direction: 'in', amountMinor: 10_000, occurredAt: '2026-09-05T13:00:00.000Z', kind: 'transfer-internal' });
    const far = tx({ direction: 'in', amountMinor: 10_000, occurredAt: '2026-09-07T12:00:00.000Z', kind: 'transfer-internal' });

    const result = pairInternalTransfers([out, far, near]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.inIds).toEqual([near.id]);
  });

  it('leaves an unpaired remainder alone rather than discarding it', () => {
    const lonely = tx({ direction: 'out', amountMinor: 12_345, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal' });
    const result = pairInternalTransfers([lonely]);
    expect(result.pairs).toHaveLength(0);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.kind).toBe('transfer-internal');
  });

  it('never pairs a row with itself', () => {
    const single = tx({ direction: 'out', amountMinor: 10_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal' });
    expect(pairInternalTransfers([single]).pairs).toHaveLength(0);
  });
});

describe('pairInternalTransfers — one to many', () => {
  it('matches a single transfer-out settled as several transfer-ins', () => {
    const out = tx({ direction: 'out', amountMinor: 30_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal', rawDescription: '转出' });
    const partA = tx({ direction: 'in', amountMinor: 10_000, occurredAt: '2026-09-05T12:30:00.000Z', kind: 'transfer-internal', rawDescription: '转入' });
    const partB = tx({ direction: 'in', amountMinor: 20_000, occurredAt: '2026-09-05T12:40:00.000Z', kind: 'transfer-internal', rawDescription: '转入' });

    const result = pairInternalTransfers([out, partA, partB]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.mode).toBe('grouped');
    expect(result.pairs[0]!.outIds).toEqual([out.id]);
    expect(new Set(result.pairs[0]!.inIds)).toEqual(new Set([partA.id, partB.id]));
  });

  it('matches the mirrored case of several outs against one in', () => {
    const inc = tx({ direction: 'in', amountMinor: 30_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal', rawDescription: '转入' });
    const partA = tx({ direction: 'out', amountMinor: 12_000, occurredAt: '2026-09-05T12:20:00.000Z', kind: 'transfer-internal', rawDescription: '转出' });
    const partB = tx({ direction: 'out', amountMinor: 18_000, occurredAt: '2026-09-05T12:50:00.000Z', kind: 'transfer-internal', rawDescription: '转出' });

    const result = pairInternalTransfers([inc, partA, partB]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.inIds).toEqual([inc.id]);
    expect(new Set(result.pairs[0]!.outIds)).toEqual(new Set([partA.id, partB.id]));
  });

  it('does not invent a group when nothing sums correctly', () => {
    const out = tx({ direction: 'out', amountMinor: 30_000, occurredAt: '2026-09-05T12:00:00.000Z', kind: 'transfer-internal' });
    const partA = tx({ direction: 'in', amountMinor: 10_000, occurredAt: '2026-09-05T12:30:00.000Z', kind: 'transfer-internal' });
    const partB = tx({ direction: 'in', amountMinor: 11_000, occurredAt: '2026-09-05T12:40:00.000Z', kind: 'transfer-internal' });

    expect(pairInternalTransfers([out, partA, partB]).pairs).toHaveLength(0);
  });
});
