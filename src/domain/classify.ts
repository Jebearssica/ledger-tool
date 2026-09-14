/**
 * Kind classification. See AGENTS.md §4, §6 and §6.1.
 *
 * This is the highest-risk logic in the project: getting it wrong silently
 * doubles the user's apparent spending, which is exactly the failure mode the
 * plan's "repeat recording" concern describes.
 */
import type { DraftTransaction, TransactionKind } from './types';

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
 */
const CLOSED_STATUS_RE = /(交易关闭|订单关闭|已关闭|交易失败|支付失败|已取消|已撤销|撤单|已失效|交易超时)/;

/**
 * Repayments clear a liability; they are not new spending.
 *
 * The trigger is the word 还款/偿还, NOT 花呗/信用卡. Keying on the product name
 * would wrongly reclassify an ordinary Huabei *purchase* (which is a genuine
 * expense) as a repayment.
 */
const REPAYMENT_RE = /(还款|偿还|结清|待还|自动扣款|全额还款|最低还款)/;

/** Brokerage / wealth-management movement: real money, but not consumption. */
const INVESTMENT_RE = /(银证转账|三方存管|证券|股票|基金|理财|期货|国债|信托|黄金|贵金属|投资|定投)/;

/**
 * Fees, interest and penalties ARE genuine spending even when the platform
 * attaches them to a non-cashflow row. See AGENTS.md §6.1.
 */
const FEE_RE = /(手续费|服务费|分期手续费|利息|逾期费|违约金|年费|管理费|利费)/;

export function isClosedOrFailed(draft: DraftTransaction): boolean {
  const status = draft.status ?? '';
  if (CLOSED_STATUS_RE.test(status)) return true;
  // Some exporters only surface the state inside the description.
  return CLOSED_STATUS_RE.test(draft.description);
}

/**
 * A refund row. Alipay emits `交易状态 = 退款成功` with `交易分类 = 退款`.
 * Unpaired refunds are kept as `refund` (excluded from cashflow) rather than
 * dropped, so an unmatched refund never silently disappears.
 */
export function isRefundRow(draft: DraftTransaction): boolean {
  const status = draft.status ?? '';
  if (/(退款成功|已全额退款|已退款|退款完成)/.test(status)) return true;
  return draft.txType === '退款';
}

export function classifyKind(draft: DraftTransaction): TransactionKind {
  const text = haystack(draft);

  // 1. Fees first: they are real costs that ride along with a liability
  //    movement, so they must be claimed before the transfer rules below.
  if (draft.direction === 'out' && FEE_RE.test(text)) return 'expense';

  // 2. Repayment of a credit line (Huabei / credit card / Jiebei / Baitiao).
  if (REPAYMENT_RE.test(text)) return 'transfer-repayment';

  // 3. Brokerage / investment movement — recorded separately, never in cashflow.
  if (INVESTMENT_RE.test(text)) return 'transfer-investment';

  // 4. The platform itself said this row is not income/expense. Trust it: both
  //    Alipay (`不计收支`) and WeChat (`收/支 = "/"`) mark transfers natively.
  if (draft.excludedFromCashflow) return 'transfer-internal';

  // 5. Ordinary cashflow.
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
