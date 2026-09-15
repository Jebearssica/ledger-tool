import { describe, expect, it } from 'vitest';
import type { Direction } from '../domain/types';
import { fingerprint, fingerprintPreimage, normalizeCounterparty, fnv1a64Hex } from '../domain/fingerprint';

describe('fnv1a64Hex', () => {
  it('is deterministic and 16 hex characters wide', () => {
    expect(fnv1a64Hex('hello')).toBe(fnv1a64Hex('hello'));
    expect(fnv1a64Hex('hello')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates different inputs', () => {
    expect(fnv1a64Hex('hello')).not.toBe(fnv1a64Hex('hellp'));
    expect(fnv1a64Hex('')).not.toBe(fnv1a64Hex('a'));
  });

  it('handles non-ASCII deterministically', () => {
    expect(fnv1a64Hex('示例餐厅')).toBe(fnv1a64Hex('示例餐厅'));
    expect(fnv1a64Hex('示例餐厅')).not.toBe(fnv1a64Hex('示例超市'));
  });
});

describe('normalizeCounterparty', () => {
  it('removes cosmetic differences', () => {
    expect(normalizeCounterparty('  示例 餐厅 ')).toBe(normalizeCounterparty('示例餐厅'));
    expect(normalizeCounterparty('Example Shop')).toBe(normalizeCounterparty('exampleshop'));
    expect(normalizeCounterparty('示例（餐厅）')).toBe(normalizeCounterparty('示例(餐厅)'));
  });

  it('treats missing values as empty', () => {
    expect(normalizeCounterparty(undefined)).toBe('');
    expect(normalizeCounterparty('')).toBe('');
  });
});

describe('fingerprint', () => {
  const base = {
    occurredAt: '2026-09-14T02:30:00.000Z',
    amountMinor: 2850,
    direction: 'out' as Direction,
  };

  it('is stable for identical input', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('changes with amount, direction and counterparty', () => {
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, amountMinor: 2851 }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, direction: 'in' }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, counterparty: '示例超市' }));
  });

  it('prefers the running balance when one is present', () => {
    const withBalance = fingerprintPreimage({ ...base, balanceAfterMinor: 100_000 });
    expect(withBalance).toContain('|bal|');
    expect(withBalance).toContain('100000');
  });

  it('prefers the platform order id above everything else', () => {
    // An order id is unique and stable, so no heuristic is needed at all.
    const preimage = fingerprintPreimage({
      ...base,
      orderId: '2026091422001490831405354054',
      balanceAfterMinor: 100_000,
    });
    expect(preimage).toContain('|ord|');
    expect(preimage).toContain('2026091422001490831405354054');
  });

  it('keys on the order id plus the amount, so the same payment dedupes across exports', () => {
    // A monthly and a yearly export of the same payment carry the same id and
    // may disagree about the timestamp; they must still collapse to one row.
    const a = fingerprint({ ...base, orderId: 'ORDER-1', occurredAt: '2026-09-14T02:30:00.000Z' });
    const b = fingerprint({ ...base, orderId: 'ORDER-1', occurredAt: '2026-09-20T09:00:00.000Z' });
    expect(a).toBe(b);
  });

  it('keeps the two halves of a split row apart despite a shared order id', () => {
    // One WeChat withdrawal becomes a principal plus a service fee. Both carry
    // the same order id, and only the fee is spending -- so they must not merge.
    const principal = fingerprint({ ...base, orderId: 'ORDER-2', amountMinor: 49_950 });
    const fee = fingerprint({ ...base, orderId: 'ORDER-2', amountMinor: 50 });
    expect(principal).not.toBe(fee);
  });

  it('ignores a blank order id and falls through to the other strategies', () => {
    expect(fingerprintPreimage({ ...base, orderId: '   ' })).toContain('|win|');
  });

  it('separates same-minute same-amount orders that differ only in description', () => {
    // The real bug: Alipay auto-invest fires several equal round-amount orders
    // for the same fund platform within the same minute. Without the fund name
    // in the key, distinct purchases hashed identically and were dropped as
    // duplicates -- about 11% of one year's non-cashflow rows.
    const fundA = fingerprint({
      ...base,
      counterparty: '蚂蚁财富-蚂蚁（杭州）基金销售有限公司',
      description: '蚂蚁财富-华夏纳斯达克100ETF联接(QDII)A-买入',
    });
    const fundB = fingerprint({
      ...base,
      counterparty: '蚂蚁财富-蚂蚁（杭州）基金销售有限公司',
      description: '蚂蚁财富-招商纳斯达克100ETF联接(QDII)A-买入',
    });
    expect(fundA).not.toBe(fundB);
  });

  it('ignores small clock differences by bucketing time', () => {
    // Two exports of the same payment can disagree by a minute or two.
    const a = fingerprint({ ...base, occurredAt: '2026-09-14T02:30:30.000Z' });
    const b = fingerprint({ ...base, occurredAt: '2026-09-14T02:31:45.000Z' });
    expect(a).toBe(b);
  });

  it('does not bucket when a balance makes the row unique', () => {
    const a = fingerprint({ ...base, occurredAt: '2026-09-14T02:30:30.000Z', balanceAfterMinor: 5 });
    const b = fingerprint({ ...base, occurredAt: '2026-09-14T02:31:45.000Z', balanceAfterMinor: 5 });
    expect(a).not.toBe(b);
  });

  it('embeds the version so an algorithm change is detectable', () => {
    expect(fingerprintPreimage(base)).toMatch(/^v2\|/);
  });
});
