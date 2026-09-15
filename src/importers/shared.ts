/**
 * Helpers shared by the platform-specific importers.
 */
import type { Direction } from '../domain/types';

/**
 * Some rows carry no usable direction: Alipay reports `不计收支` and WeChat
 * reports `/`, neither of which says which way the money went.
 *
 * Most of these rows end up classified as transfers, where a wrong guess only
 * affects pairing. That is no longer universally true: credited interest is
 * classified as INCOME (see classifyKind), so for those rows the direction is
 * part of a real total and must be right. Interest wording is therefore listed
 * explicitly below rather than left to the fallback.
 */
const OUT_HINTS = /(转出|支出|付款|提现|扣款|还款|消费|购买|买入|转到|转给|转至|转入余额宝|转入理财|转出到)/;
const IN_HINTS = /(转入|收入|收款|充值|赎回|卖出|收钱|转账给你|转入到|转入零钱|收益发放|结息|派息|分红|利息收入)/;

export function inferDirectionFromText(text: string): Direction {
  const t = text.toLowerCase();
  // Out-hints are tested first on purpose: "转入余额宝" contains "转入" but is
  // money leaving the spendable balance.
  if (OUT_HINTS.test(t)) return 'out';
  if (IN_HINTS.test(t)) return 'in';
  return 'out';
}

/** Build the error shown when a file's headers do not match what we expect. */
export function headerMismatchError(
  sourceLabel: string,
  missing: readonly string[],
  actualHeader: readonly string[],
): Error {
  return new Error(
    `${sourceLabel}: this file does not match the expected layout. ` +
      `Missing columns: ${missing.join(', ') || '(none)'}. ` +
      `Found columns: ${actualHeader.filter((c) => c !== '').join(' | ') || '(none)'}. ` +
      `The platform may have changed its export format; refusing to parse the columns out of order.`,
  );
}
