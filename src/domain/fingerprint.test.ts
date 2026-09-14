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
    expect(fingerprintPreimage(base)).toMatch(/^v1\|/);
  });
});
