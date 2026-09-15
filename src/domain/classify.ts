/**
 * Kind classification. See AGENTS.md §4, §6 and §6.1.
 *
 * This is the highest-risk logic in the project: getting it wrong silently
 * doubles the user's apparent spending, which is exactly the failure mode the
 * plan's "repeat recording" concern describes.
 */
import type { DraftTransaction, TransactionKind } from './types';
import { parseAmountToMinor } from './money';

/** Combine every human-readable field into one haystack for keyword tests. */
function haystack(draft: DraftTransaction): string {
  const verified = draft.raw['交易类型'] ?? '';
  return [draft.counterparty ?? '', draft.description, draft.txType ?? '', verified, draft.method ?? '']
    .join(' ')
    .toLowerCase();
}

/**
 * Rows the platform reported as never having happened. Recording these invents
 * spending out of thin air.
 *
 * The status field is matched loosely: real exports use more wordings than any
 * fixed list can enumerate. Observed in the wild include 还款失败 (a failed
 * credit-line repayment, which a narrower list missed and so recorded as a real
 * repayment) alongside 交易关闭 / 交易失败 / 已取消 / 已撤销.
 */
const CLOSED_STATUS_RE = /(关闭|失败|取消|撤销|撤单|失效|超时)/;

/**
 * The same condition, but tested against free text, where a loose match would
 * produce false positives (a merchant name could legitimately contain 失败).
 */
const CLOSED_TEXT_RE = /(交易关闭|订单关闭|已关闭|交易失败|支付失败|还款失败|已取消|已撤销|撤单|已失效|交易超时)/;

/**
 * Repayments clear a liability; they are not new spending.
 *
 * The trigger is the word 还款/偿还, NOT 花呗/信用卡. Keying on the product name
 * would wrongly reclassify an ordinary Huabei *purchase* (which is a genuine
 * expense) as a repayment.
 */
const REPAYMENT_RE = /(还款|偿还|结清|待还|自动扣款|全额还款|最低还款)/;

/**
 * Brokerage / wealth-management movement: real money, but not consumption.
 *
 * These words have no ordinary-merchant meaning, so they are trusted anywhere
 * in the row, including the counterparty — bank statements routinely put
 * 银证转账 only in the counterparty column.
 */
const INVESTMENT_RE = /(银证转账|三方存管|证券|股票|基金|理财|期货|国债|信托|投资|定投)/;

/**
 * Precious-metal words are ALSO ordinary product and merchant names, so they are
 * believed only when the platform has already said the row is not cashflow.
 *
 * A real one-year statement contained exactly one row matching these words: a
 * shampoo (交易分类 美容美发, ¥26.57) bought from a merchant the platform had
 * masked as `黄金**半`. A loose match read that as a gold investment and quietly
 * removed real spending from the totals — the same failure mode as the interest
 * rows, mirrored. Trusting the platform's own 不计收支 flag instead of the word
 * keeps genuine gold purchases (which are always 不计收支) while restoring this
 * one.
 */
const INVESTMENT_BY_FLAG_RE = /(黄金|贵金属|积存金|金条|金价)/;

/**
 * Fees, interest and penalties ARE genuine spending even when the platform
 * attaches them to a non-cashflow row. See AGENTS.md §6.1.
 */
const FEE_RE = /(手续费|服务费|分期手续费|利息|逾期费|违约金|年费|管理费|利费)/;

/**
 * Interest EARED is income, not a transfer, and this is easy to get wrong.
 *
 * A wallet paying daily interest produces rows like
 * `余额宝-2026.09.13-收益发放` which the platform marks 不计收支, because from its
 * point of view nothing left the wallet. Economically the balance grew, so it is
 * income — and treating it as an investment movement hides hundreds of rows of
 * real income. A real one-year statement contained 365 such rows.
 *
 * Matched against the DESCRIPTION only. The 交易分类 column of these very rows
 * reads 投资理财, so testing the whole haystack would match 投资 and send them back
 * down the investment path.
 */
const INTEREST_INCOME_RE = /(收益发放|结息|利息收入|派息|分红|分红发放)/;

/** Interest wording that must NOT be read as income when money is leaving. */
const FEE_CONTEXT_RE = /(手续费|服务费|逾期费|违约金|管理费|利费)/;

export function isClosedOrFailed(draft: DraftTransaction): boolean {
  const status = draft.status ?? '';
  if (status !== '' && CLOSED_STATUS_RE.test(status)) return true;
  // Some exporters only surface the state inside the description.
  return CLOSED_TEXT_RE.test(draft.description);
}

/**
 * A partial-refund figure that the row's own status discloses, in minor units.
 *
 * WeChat does not emit a separate refund row against a linkable order id the way
 * Alipay does. Instead it rewrites the ORIGINAL PURCHASE row's 当前状态 to say how
 * much came back — `已退款(¥9.00)` — and gives the refund leg a 交易单号 that has
 * no relationship to the purchase's. Measured on a real yearly export: all 12
 * refund rows failed all five id-based linkage rules that were tried, so the
 * figure carried by the purchase's own status is the only signal that exists.
 *
 * `已全额退款` deliberately names no figure. There the whole purchase is gone and
 * the row must be removed rather than netted, and returning `null` keeps it on
 * that path. Alipay never writes a figure into 交易状态 either, so this is inert
 * for Alipay and the order-id pairing stays in charge.
 *
 * The equality guard is what makes "partial" mean partial: a figure equal to the
 * row reverses the row entirely, and a larger one contradicts the statement —
 * turning either into a deduction would invent spending that never happened.
 *
 * @returns minor units, only when strictly smaller than the row it appears on.
 */
export function disclosedPartialRefundMinor(draft: DraftTransaction): number | null {
  const status = draft.status ?? '';
  if (!status.includes('退')) return null;

  /**
   * Both real spellings carry the currency marker (`已退款(¥9.00)`, `已退款¥9.00`).
   * A parenthesised figure is also accepted, but only when it looks like money —
   * a decimal point — so that unrelated parentheses such as `退款(3天到账)` can
   * never be read as a ¥0.03 deduction.
   */
  const figure = /(?:[¥￥]\s*(\d+(?:\.\d{1,2})?)|[(（]\s*(\d+\.\d{1,2})\s*[)）])/.exec(status);
  const text = figure?.[1] ?? figure?.[2];
  if (!text) return null;

  const disclosed = parseAmountToMinor(text);
  if (disclosed === null || disclosed <= 0) return null;

  return disclosed < draft.amountMinor ? disclosed : null;
}

/**
 * A refund row — a record that money came back, rather than a purchase.
 *
 * Alipay emits `交易状态 = 退款成功` with `交易分类 = 退款`. Unpaired refunds are
 * kept as `refund` (excluded from cashflow) rather than dropped, so an unmatched
 * refund never silently disappears.
 *
 * A purchase that discloses a PARTIAL refund of itself is explicitly not one of
 * these. Its status also reads `已退款…`, and matching those words here discarded
 * the entire purchase: a real ¥154.00 order left the ¥145.00 that genuinely left
 * the account out of every total.
 */
export function isRefundRow(draft: DraftTransaction): boolean {
  if (disclosedPartialRefundMinor(draft) !== null) return false;

  const status = draft.status ?? '';
  if (/(退款成功|已全额退款|已退款|退款完成)/.test(status)) return true;
  return draft.txType === '退款';
}

export function classifyKind(draft: DraftTransaction): TransactionKind {
  const text = haystack(draft);

  // 1. Fees first: they are real costs that ride along with a liability
  //    movement, so they must be claimed before the transfer rules below.
  if (draft.direction === 'out' && FEE_RE.test(text)) return 'expense';

  // 2. Interest credited to the user's own balance is genuine income. This must
  //    be tested before the investment rule, because these rows are filed under
  //    交易分类 = 投资理财 and would otherwise be discarded as transfers.
  const description = draft.description ?? '';
  if (
    draft.direction === 'in' &&
    INTEREST_INCOME_RE.test(description) &&
    !FEE_CONTEXT_RE.test(description)
  ) {
    return 'income';
  }

  // 3. Repayment of a credit line (Huabei / credit card / Jiebei / Baitiao).
  if (REPAYMENT_RE.test(text)) return 'transfer-repayment';

  // 4. Brokerage / investment movement — recorded separately, never in cashflow.
  if (INVESTMENT_RE.test(text)) return 'transfer-investment';

  // 4b. Words that are equally plausible as merchant or product names only get
  //     to mean an investment when the platform already marked the row itself
  //     as not affecting income and expense.
  if (draft.excludedFromCashflow && INVESTMENT_BY_FLAG_RE.test(text)) {
    return 'transfer-investment';
  }

  // 5. The platform itself said this row is not income/expense. Trust it: both
  //    Alipay (`不计收支`) and WeChat (`收/支 = "/"`) mark transfers natively.
  if (draft.excludedFromCashflow) return 'transfer-internal';

  // 6. Ordinary cashflow.
  return draft.direction === 'in' ? 'income' : 'expense';
}

/**
 * Heuristic hint that a row may be a leg of an internal transfer, used by the
 * pairing pass to decide which rows are even worth matching.
 */
const TRANSFER_HINT_RE = /(转账|转出|转入|充值|提现|代付|划转|汇款|转入到|转至|内部|归集|资金归集)/;

export function looksLikeTransfer(draft: DraftTransaction): boolean {
  if (draft.excludedFromCashflow) return true;
  return TRANSFER_HINT_RE.test(haystack(draft));
}
