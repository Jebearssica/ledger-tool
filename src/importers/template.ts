/**
 * Column-mapping templates. See AGENTS.md §8.
 *
 * Architecture decision, confirmed with the user: drive the generic importer by
 * FORMAT, not by institution. The set of container formats a Chinese bank can
 * produce is small and knowable (csv / txt / xls / xlsx / pdf); the number of
 * banks is not, and each one changes its layout without warning. So instead of
 * `if (bank === 'cmb')`, the user maps column names to fields once, and that
 * mapping is versioned.
 *
 * A template MUST carry a version. When a bank reshuffles its columns, a pinned
 * `cmb@2026-09` keeps parsing old files correctly instead of silently reading
 * the wrong column under a new template.
 */
import type { Direction } from '../domain/types';

export interface ColumnMapping {
  /** Column holding the transaction date. Required. */
  date: string;
  /**
   * Column holding a separate time of day, when the file splits it from the date
   * (`记账日期` + `记账时间`). Without it every row would land on midnight.
   */
  time?: string;
  /** Single amount column. Sign or the `direction` column decides in/out. */
  amount?: string;
  /** Separate credit column (money in). Most Chinese bank statements use this. */
  income?: string;
  /** Separate debit column (money out). */
  expense?: string;
  balance?: string;
  /** Column whose values mean income vs expense, e.g. `收/支` or `借/贷`. */
  direction?: string;
  counterparty?: string;
  description?: string;
  status?: string;
  orderId?: string;
  txType?: string;
  method?: string;
}

/** How to read the sign of a single `amount` column. */
export type AmountMode = 'signed' | 'positive-is-expense' | 'positive-is-income';

export interface Template {
  /** Stable identity, e.g. `demo-bank@2026-09`. The suffix is the version. */
  id: string;
  label: string;
  /** Free-text note shown in the mapping UI. */
  note?: string;
  columns: ColumnMapping;
  /** `''` means auto-detect. */
  delimiter?: string;
  encoding?: 'auto' | 'utf-8' | 'gbk';
  /** 0-based header row; `-1` means auto-detect. */
  headerRow?: number;
  /** Strings in the `direction` column that mean money in / money out. */
  directionValues?: { in: string[]; out: string[] };
  amountMode?: AmountMode;
  /** Remove tab characters before parsing (WeChat-style exports). */
  stripTabs?: boolean;
}

export const DEFAULT_DIRECTION_VALUES = {
  in: ['收入', '收', '贷', '进', '存入', '转入', 'credit', 'in'],
  out: ['支出', '支', '借', '出', '支取', '转出', 'debit', 'out'],
};

/**
 * Verified layout: Bank of China debit-card statement PDF, exported 2026-09.
 *
 * The columns were read off a real 11-page export whose own per-page
 * `借方发生数` / `贷方发生数` totals reconcile exactly against the parsed amounts,
 * so the mapping is confirmed rather than guessed. Two details are specific to
 * this format and worth knowing:
 *
 *   - `金额` is SIGNED: a leading `-` is money out. There is no 收/支 column.
 *   - `交易名称` carries the kind (`银证转账`, `跨行转账`, `小额普通`, `结息`),
 *     `附言` the free-text note and `对方账户名` the counterparty. Merchants live
 *     in 对方账户名 for card payments, so both are mapped.
 *
 * Bump the version suffix if Bank of China reshuffles the columns; the pinned id
 * is what keeps an older file parsing under the older mapping.
 */
export const BOC_DEBIT_PDF_TEMPLATE: Template = {
  id: 'boc-debit-pdf@2026-09',
  label: '中国银行：借记卡交易流水明细清单（PDF）',
  note:
    '已核对：中国银行借记卡 PDF 流水（记账日期/记账时间/金额/余额/交易名称/渠道/附言/对方账户名）。' +
    '金额带正负号，负数=支出。该表由 PDF 坐标重建而来，导入前请核对预览中的行数与合计。',
  columns: {
    date: '记账日期',
    time: '记账时间',
    amount: '金额',
    balance: '余额',
    txType: '交易名称',
    method: '渠道',
    description: '附言',
    counterparty: '对方账户名',
  },
  amountMode: 'signed',
};

/**
 * Starter templates. The two `demo-*` entries below are STARTING POINTS, not
 * verified layouts: no real file was available when they were written. The user
 * is expected to open the mapping UI, check the column names against their own
 * export, and save a corrected version — which then outranks them, because the
 * UI lists saved templates before these.
 */
export const STARTER_TEMPLATES: readonly Template[] = [
  BOC_DEBIT_PDF_TEMPLATE,
  {
    id: 'demo-bank@2026-09',
    label: '示例：借记卡（收入/支出分列）',
    note:
      'STARTING POINT ONLY. Many Chinese debit-card exports put money-in and money-out in two separate ' +
      'columns and carry a running balance. Verify the column names against your own file before saving.',
    columns: {
      date: '交易日期',
      income: '收入',
      expense: '支出',
      balance: '余额',
      counterparty: '对方户名',
      description: '摘要',
      status: '交易状态',
    },
    amountMode: 'positive-is-expense',
  },
  {
    id: 'demo-credit@2026-09',
    label: '示例：信用卡（单金额列 + 借贷标志）',
    note:
      'STARTING POINT ONLY. Credit-card statements usually give one signed amount column plus a direction ' +
      'flag. Verify against your own file before saving.',
    columns: {
      date: '交易日期',
      amount: '交易金额',
      direction: '借/贷',
      counterparty: '交易描述',
      description: '交易描述',
    },
    amountMode: 'signed',
  },
];

/** Fields that are present in the mapping and must therefore exist in the file. */
export function requiredColumnNames(template: Template): string[] {
  const { columns } = template;
  const names = [
    columns.date,
    columns.time,
    columns.amount,
    columns.income,
    columns.expense,
    columns.direction,
    columns.balance,
    columns.counterparty,
    columns.description,
    columns.status,
    columns.orderId,
    columns.txType,
    columns.method,
  ].filter((v): v is string => typeof v === 'string' && v !== '');

  return [...new Set(names)];
}

export interface TemplateValidation {
  ok: boolean;
  missing: string[];
  /** True when no way of deriving an amount is mapped at all. */
  noAmountSource: boolean;
}

export function validateTemplate(template: Template, header: readonly string[]): TemplateValidation {
  const present = new Set(header.map((h) => h.trim()).filter((h) => h !== ''));
  const missing = requiredColumnNames(template).filter((name) => !present.has(name));
  const hasAmountSource =
    Boolean(template.columns.amount) ||
    Boolean(template.columns.income) ||
    Boolean(template.columns.expense);

  return {
    ok: missing.length === 0 && hasAmountSource,
    missing,
    noAmountSource: !hasAmountSource,
  };
}

export function resolveDirectionValues(template: Template): { in: string[]; out: string[] } {
  return template.directionValues ?? DEFAULT_DIRECTION_VALUES;
}

export type { Direction };
