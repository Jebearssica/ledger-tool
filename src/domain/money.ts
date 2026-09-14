/**
 * Integer minor-unit money handling. See AGENTS.md §4.
 *
 * Everything here is integer maths. `parseFloat(x) * 100` is explicitly
 * forbidden: 18.9 * 100 === 1889.9999999999998, and a bookkeeping tool that is
 * off by a cent is worse than one that refuses to run.
 */

/** Decimal places for a currency. CNY and most others use 2. */
export const MINOR_SCALE = 2;

/**
 * Parse a human/exchange-formatted amount into integer minor units.
 *
 * Handles the shapes that actually appear in Chinese bank and platform exports:
 *   "18.90"  "¥1,234.56"  "-42"  "(1,234.56)"  "￥12"  "１２３．４５"
 *
 * @returns integer minor units, or `null` when the input is not a usable amount.
 */
export function parseAmountToMinor(input: unknown, scale: number = MINOR_SCALE): number | null {
  if (input === null || input === undefined) return null;

  // NFKC folds full-width forms (１２３．４５ → 123.45, ￥ → ¥) so we do not need
  // a hand-maintained translation table.
  let s = String(input).normalize('NFKC').trim();
  if (s === '' || s === '-' || s === '/' || s === '—') return null;

  let negative = false;

  // Accounting notation: a parenthesised figure is negative.
  const parenthesised = /^\((.*)\)$/.exec(s);
  if (parenthesised) {
    negative = true;
    s = parenthesised[1]!.trim();
  }

  s = s.replace(/[\s,\u00a0]/g, ''); // thousands separators + non-breaking space
  s = s.replace(/[^\d.+-]/g, ''); // currency symbols, "元", "CNY", …

  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.includes('-') || s === '' || s === '.') return null;

  const parts = s.split('.');
  if (parts.length > 2) return null;

  const intPart = parts[0] === '' ? '0' : parts[0]!;
  let fracDigits = parts[1] ?? '';
  if (!/^\d+$/.test(intPart)) return null;
  if (fracDigits !== '' && !/^\d+$/.test(fracDigits)) return null;

  let int = BigInt(intPart);

  // Round half-up on the first digit beyond `scale` rather than silently
  // truncating: a dropped cent is a real bug that is very hard to notice.
  if (fracDigits.length > scale) {
    const dropped = fracDigits.slice(scale);
    fracDigits = fracDigits.slice(0, scale);
    if (dropped.charCodeAt(0) >= 0x35 /* '5' */) {
      // padStart, not padEnd: incrementing "00" yields "1", which must become
      // "01" — padding it to "10" would turn 1.005 into 1.10.
      const bumped = (BigInt(fracDigits || '0') + 1n).toString().padStart(scale, '0');
      if (bumped.length > scale) {
        int += 1n;
        fracDigits = bumped.slice(1);
      } else {
        fracDigits = bumped;
      }
    }
  }

  const scalePow = 10n ** BigInt(scale);
  const frac = BigInt(fracDigits.padEnd(scale, '0').slice(0, scale) || '0');
  const minor = int * scalePow + frac;

  const asNumber = Number(minor);
  if (!Number.isSafeInteger(asNumber)) return null; // absurd magnitude, refuse
  return negative ? -asNumber : asNumber;
}

/** Render integer minor units for display. UI-only — never feed this back to maths. */
export function formatMinor(minor: number, currency = 'CNY'): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  return `${negative ? '-' : ''}${symbol}${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

/** Integer sum. Exists so call sites never reach for `reduce` with floats. */
export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Convert integer minor units to a plain decimal string (e.g. 1890 → "18.90").
 * Used for exports and for feeding values back to an input field.
 */
export function minorToDecimalString(minor: number, scale: number = MINOR_SCALE): string {
  const negative = minor < 0;
  const s = String(Math.abs(minor)).padStart(scale + 1, '0');
  const cut = s.length - scale;
  return `${negative ? '-' : ''}${s.slice(0, cut)}.${s.slice(cut)}`;
}
