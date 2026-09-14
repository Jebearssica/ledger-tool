import { describe, expect, it } from 'vitest';
import {
  formatMinor,
  minorToDecimalString,
  parseAmountToMinor,
  sumMinor,
} from '../domain/money';

describe('parseAmountToMinor', () => {
  it('parses plain decimals into integer minor units', () => {
    expect(parseAmountToMinor('28.50')).toBe(2850);
    expect(parseAmountToMinor('0.01')).toBe(1);
    expect(parseAmountToMinor('12000.00')).toBe(1_200_000);
    expect(parseAmountToMinor('7')).toBe(700);
    expect(parseAmountToMinor('.5')).toBe(50);
  });

  it('does not introduce floating point error', () => {
    // The naive implementation, Math.round(parseFloat('18.90') * 100), is
    // actually safe here — but 8.11 * 100 is not, so the guard has to be real.
    expect(parseAmountToMinor('8.11')).toBe(811);
    expect(parseAmountToMinor('1.005')).toBe(101); // half-up on the 3rd digit
    expect(parseAmountToMinor('18.90')).toBe(1890);
    expect(parseAmountToMinor('1.10')).toBe(110);
    expect(parseAmountToMinor('4.35')).toBe(435);
    expect(parseAmountToMinor('1.115')).toBe(112);
  });

  it('strips currency symbols, separators and whitespace', () => {
    expect(parseAmountToMinor('¥1,234.56')).toBe(123_456);
    expect(parseAmountToMinor('￥12')).toBe(1200);
    expect(parseAmountToMinor(' 1,000 ')).toBe(100_000);
    expect(parseAmountToMinor('28.50元')).toBe(2850);
    expect(parseAmountToMinor('CNY 28.50')).toBe(2850);
  });

  it('folds full-width characters', () => {
    expect(parseAmountToMinor('１２３．４５')).toBe(12_345);
    expect(parseAmountToMinor('￥１２')).toBe(1200);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseAmountToMinor('(1,234.56)')).toBe(-123_456);
    expect(parseAmountToMinor('(28.50)')).toBe(-2850);
  });

  it('handles explicit signs', () => {
    expect(parseAmountToMinor('-42.00')).toBe(-4200);
    expect(parseAmountToMinor('+42.00')).toBe(4200);
  });

  it('rounds half up rather than truncating', () => {
    expect(parseAmountToMinor('0.005')).toBe(1);
    expect(parseAmountToMinor('0.004')).toBe(0);
    expect(parseAmountToMinor('9.999')).toBe(1000);
  });

  it('propagates a carry out of the fractional part', () => {
    expect(parseAmountToMinor('1.999')).toBe(200);
    expect(parseAmountToMinor('99.999')).toBe(10_000);
  });

  it('returns null for anything unusable instead of guessing', () => {
    for (const input of [null, undefined, '', ' ', '-', '/', '—', 'abc', '1.2.3', '1-2', '¥', '.']) {
      expect(parseAmountToMinor(input)).toBeNull();
    }
  });

  it('accepts numbers as well as strings', () => {
    expect(parseAmountToMinor(28.5)).toBe(2850);
    expect(parseAmountToMinor(0)).toBe(0);
  });

  it('preserves large integers exactly', () => {
    // 21,474,836.47 is the largest amount representable with cent precision in
    // a 2^53 integer, so it is a meaningful upper bound to check.
    expect(parseAmountToMinor('21474836.47')).toBe(2_147_483_647);
  });
});

describe('formatMinor', () => {
  it('renders cents with a currency symbol and thousands separators', () => {
    expect(formatMinor(2850)).toBe('¥28.50');
    expect(formatMinor(0)).toBe('¥0.00');
    expect(formatMinor(1)).toBe('¥0.01');
    expect(formatMinor(123_456)).toBe('¥1,234.56');
    expect(formatMinor(-2850)).toBe('-¥28.50');
    expect(formatMinor(1_200_000)).toBe('¥12,000.00');
  });

  it('uses a prefix for non-CNY currencies', () => {
    expect(formatMinor(100, 'USD')).toBe('USD 1.00');
  });
});

describe('minorToDecimalString', () => {
  it('round-trips through parseAmountToMinor', () => {
    for (const minor of [0, 1, 50, 2850, 123_456, 1_200_000, -2850]) {
      expect(parseAmountToMinor(minorToDecimalString(minor))).toBe(minor);
    }
  });

  it('pads small values correctly', () => {
    expect(minorToDecimalString(1)).toBe('0.01');
    expect(minorToDecimalString(0)).toBe('0.00');
    expect(minorToDecimalString(-5)).toBe('-0.05');
  });
});

describe('sumMinor', () => {
  it('stays exact over many additions', () => {
    // 0.1 added 1000 times must be exactly 100.00, which float arithmetic fails.
    const cents = new Array(1000).fill(10);
    expect(sumMinor(cents)).toBe(10_000);
    expect(sumMinor([])).toBe(0);
  });
});
