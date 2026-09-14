/**
 * WeChat Pay importer. See AGENTS.md §8.1, §8.2, §8.3.
 *
 * Facts this implementation depends on:
 *   - WeChat exports either CSV (UTF-8) or XLSX, both with the same 11 columns.
 *   - CSV fields contain stray tab characters, inserted to stop Excel from
 *     auto-converting long order numbers. They MUST be removed before parsing
 *     or every column after the first shifts by one.
 *   - `金额` carries a `¥` prefix, stripped by the money parser.
 *   - `收/支 = "/"` is the platform's own "not income/expense" marker.
 */
import { parseAmountToMinor } from '../domain/money';
import { toUtcIso } from '../domain/dates';
import type { Direction, DraftTransaction, ParseResult, ParseWarning } from '../domain/types';
import { buildColumnIndex, cellAt, findHeaderRowIndex, type Table } from './text';
import { headerMismatchError, inferDirectionFromText } from './shared';

export const WECHAT_SOURCE = 'wechat';

const REQUIRED_HEADERS = ['交易时间', '收/支', '金额'] as const;

/** `收/支 = "/"` means the row does not affect income or expense. */
const EXCLUDED_DIRECTION = '/';

/**
 * WeChat writes a service fee into `备注` and folds it into the principal.
 *
 * The fee is a genuine expense even though the principal is not, so the row is
 * split. Note the split conserves the total by construction —
 * `(principal - fee) + fee === principal` — so even if this regex misfires, no
 * money is invented or lost; only the categorisation changes.
 */
const FEE_PATTERN = /(?:服务费|手续费|利息)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/;

/** Values WeChat writes to mean "not applicable". */
function isBlank(value: string): boolean {
  return value === '' || value === '/';
}

function describe(item: string, note: string, txType: string, counterparty: string): string {
  return (
    [item, note].filter((v) => !isBlank(v)).join(' / ') ||
    txType ||
    counterparty ||
    'WeChat transaction'
  );
}

export interface ServiceFee {
  minor: number;
  /**
   * The note with the fee clause removed.
   *
   * This matters: if the principal kept the words "服务费" it would be matched
   * by the fee rule in `classifyKind` and reclassified as an expense, which
   * would silently count the withdrawal as spending.
   */
  remainingNote: string;
}

export function parseServiceFee(note: string): ServiceFee | null {
  if (isBlank(note)) return null;

  const match = FEE_PATTERN.exec(note);
  if (!match?.[1]) return null;

  const minor = parseAmountToMinor(match[1]);
  if (minor === null || minor <= 0) return null;

  const remainingNote = (note.slice(0, match.index) + note.slice(match.index + match[0].length))
    .replace(/^[\s,，;；、]+|[\s,，;；、]+$/g, '')
    .trim();

  return { minor, remainingNote };
}

export function extractFeeMinor(note: string): number | null {
  return parseServiceFee(note)?.minor ?? null;
}

export interface WechatOptions {
  accountId: string;
  /** `csv` or `xlsx` — affects only the reported metadata. */
  format?: string;
}

export function parseWechat(table: Table, options: WechatOptions): ParseResult {
  const { rows } = table;
  const warnings: ParseWarning[] = [];

  // Scan for the header rather than counting lines: WeChat's preamble length
  // differs between the CSV and XLSX exports (AGENTS.md §8.3 rule 1).
  const headerRowIndex = findHeaderRowIndex(rows, '交易时间');

  if (headerRowIndex === -1) {
    // Note: this must NOT be inferred from the title line. Every WeChat export
    // starts with 微信支付账单明细, so a "first line contains 微信" test would
    // reject perfectly valid files.
    throw new Error(
      `WeChat: could not find a header row containing "交易时间". Actual first rows: ` +
        rows.slice(0, 3).map((r, i) => `#${i + 1}[${r.slice(0, 6).join(' | ')}]`).join(' ') +
        `. If this is a CSV export, extract the .zip first.`,
    );
  }

  const header = rows[headerRowIndex] ?? [];
  const columns = buildColumnIndex(header);

  const missing = REQUIRED_HEADERS.filter((name) => !columns.has(name));
  if (missing.length > 0) throw headerMismatchError('WeChat', missing, header);

  const drafts: DraftTransaction[] = [];
  const rawMap = new Map<string, string>();

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.every((c) => c === '')) continue;

    const record = (name: string): string => cellAt(row, columns.get(name));

    rawMap.clear();
    header.forEach((name, idx) => {
      if (name !== '') rawMap.set(name, row[idx] ?? '');
    });

    const timeText = record('交易时间');
    const occurredAt = toUtcIso(timeText);
    if (!occurredAt) {
      warnings.push({
        code: 'unparsable-date',
        row: i + 1,
        message: `Could not read a date from "${timeText}"; row skipped.`,
      });
      continue;
    }

    let amountMinor = parseAmountToMinor(record('金额'));
    if (amountMinor === null || amountMinor === 0) {
      warnings.push({
        code: 'unparsable-amount',
        row: i + 1,
        message: `Could not read an amount from "${record('金额')}"; row skipped.`,
      });
      continue;
    }

    const rawDirection = record('收/支');
    const txType = record('交易类型');
    const item = record('商品');
    const note = record('备注');
    const counterparty = record('交易对方');
    const method = record('支付方式');
    const status = record('当前状态');

    let direction: Direction;
    let excludedFromCashflow = false;

    if (rawDirection === '收入') {
      direction = 'in';
    } else if (rawDirection === '支出') {
      direction = 'out';
    } else if (rawDirection === EXCLUDED_DIRECTION || rawDirection === '') {
      excludedFromCashflow = true;
      direction = inferDirectionFromText([txType, item, note, counterparty].join(' '));
    } else {
      warnings.push({
        code: 'unknown-direction-value',
        row: i + 1,
        message: `Unrecognised 收/支 value "${rawDirection}"; row skipped rather than guessed.`,
      });
      continue;
    }

    if (amountMinor < 0) {
      amountMinor = Math.abs(amountMinor);
      direction = 'out';
    }

    const base: DraftTransaction = {
      source: WECHAT_SOURCE,
      accountId: options.accountId,
      direction,
      amountMinor,
      currency: 'CNY',
      occurredAt,
      counterparty: counterparty || undefined,
      description: describe(item, note, txType, counterparty),
      txType: txType || undefined,
      method: method || undefined,
      status: status || undefined,
      orderId: record('交易单号') || undefined,
      merchantOrderId: record('商户单号') || undefined,
      excludedFromCashflow,
      raw: Object.fromEntries(rawMap),
    };

    // Split any service fee out of the principal. Only meaningful when money is
    // leaving; a fee attached to an incoming row would be a refund of it.
    const fee = direction === 'out' ? parseServiceFee(note) : null;
    if (fee !== null && fee.minor < amountMinor) {
      drafts.push({
        ...base,
        amountMinor: amountMinor - fee.minor,
        // The fee wording is removed so this row is not mistaken for a fee itself.
        description: describe(item, fee.remainingNote, txType, counterparty),
      });

      drafts.push({
        ...base,
        // The counterparty is part of the fingerprint, so tagging it here keeps
        // the fee row from colliding with a principal of the same amount.
        counterparty: `${counterparty || 'WeChat'} (服务费)`,
        amountMinor: fee.minor,
        description: `服务费 / ${note}`,
        txType: '服务费',
        // Fees are real spending, so this row must NOT be excluded from cashflow.
        excludedFromCashflow: false,
      });
      continue;
    }

    drafts.push(base);
  }

  return {
    drafts,
    warnings,
    meta: {
      format: options.format ?? 'csv',
      encoding: options.format === 'xlsx' ? 'n/a' : 'utf-8',
      totalRows: Math.max(0, rows.length - headerRowIndex - 1),
      sourceLabel: '微信支付',
      templateId: 'wechat',
    },
  };
}
