/**
 * Alipay CSV importer. See AGENTS.md §8.1, §8.2, §8.3.
 *
 * Facts this implementation depends on:
 *   - Alipay exports CSV only, encoded GBK (handled upstream by `sniff`).
 *   - The real header line is preceded by ~23 lines of preamble. That count is
 *     NOT hardcoded: platform revisions change it, so the header is located by
 *     scanning for `交易时间`.
 *   - The `收/支` column has three values, including `不计收支`, which is the
 *     platform's own statement that a row is a transfer rather than cashflow.
 *     That flag is trusted over keyword guessing.
 */
import { parseAmountToMinor } from '../domain/money';
import { toUtcIso } from '../domain/dates';
import type { Direction, DraftTransaction, ParseResult, ParseWarning } from '../domain/types';
import { buildColumnIndex, cellAt, findHeaderRowIndex, type Table } from './text';
import { headerMismatchError, inferDirectionFromText } from './shared';

export const ALIPAY_SOURCE = 'alipay';

const REQUIRED_HEADERS = ['交易时间', '收/支', '金额'] as const;

/** Value of `收/支` meaning "this row does not affect income or expense". */
const EXCLUDED_DIRECTION = '不计收支';

export interface AlipayOptions {
  accountId: string;
}

export function parseAlipay(table: Table, options: AlipayOptions): ParseResult {
  const { rows } = table;
  const warnings: ParseWarning[] = [];

  // Locate the header by SCANNING, never by a hardcoded line number: Alipay's
  // preamble length changes between releases (AGENTS.md §8.3 rule 1).
  const headerRowIndex = findHeaderRowIndex(rows, '交易时间');

  if (headerRowIndex === -1) {
    // Distinguish "old layout" from "not an Alipay file". This must NOT be
    // inferred from the title line: every Alipay export, current ones included,
    // has 支付宝 in its title, so that test rejects valid files.
    const looksLegacy = rows.some(
      (row) => row.some((cell) => cell.includes('交易号')) && row.some((cell) => cell.includes('商品名称')),
    );

    if (looksLegacy) {
      throw new Error(
        'This looks like an OLD-FORMAT Alipay CSV: it carries 交易号 / 商品名称 columns where the current format ' +
          'has 交易订单号 / 商品说明. The layouts differ, so parsing it with these rules would assign amounts to the ' +
          'wrong columns. Please re-export the statement from the current Alipay app.',
      );
    }

    throw new Error(
      `Alipay: could not find a header row containing "交易时间". Actual first rows: ` +
        rows.slice(0, 3).map((r, i) => `#${i + 1}[${r.slice(0, 6).join(' | ')}]`).join(' '),
    );
  }

  const header = rows[headerRowIndex] ?? [];
  const columns = buildColumnIndex(header);

  const missing = REQUIRED_HEADERS.filter((name) => !columns.has(name));
  if (missing.length > 0) throw headerMismatchError('Alipay', missing, header);

  const drafts: DraftTransaction[] = [];
  const rawMap = new Map<string, string>();

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;

    const record = (name: string): string => cellAt(row, columns.get(name));
    if (row.every((c) => c === '')) continue;

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
    if (amountMinor === null) {
      warnings.push({
        code: 'unparsable-amount',
        row: i + 1,
        message: `Could not read an amount from "${record('金额')}"; row skipped.`,
      });
      continue;
    }
    if (amountMinor === 0) {
      // Distinct from unreadable: these are real rows (Alipay files medical
      // reimbursements as `医保支付(不含自费)` with 金额 = 0.00). They carry no
      // money, so they are skipped, but the user deserves to know they existed
      // rather than seeing them reported as a parsing failure.
      warnings.push({
        code: 'zero-amount',
        row: i + 1,
        message: `Amount is 0.00 ("${record('商品说明')}"); nothing to record, row skipped.`,
      });
      continue;
    }

    const rawDirection = record('收/支');
    const category = record('交易分类');
    const item = record('商品说明');
    const counterparty = record('交易对方');
    const method = record('收/付款方式');
    const status = record('交易状态');

    let direction: Direction;
    let excludedFromCashflow = false;

    if (rawDirection === '收入') {
      direction = 'in';
    } else if (rawDirection === '支出') {
      direction = 'out';
    } else if (rawDirection === EXCLUDED_DIRECTION || rawDirection === '') {
      excludedFromCashflow = true;
      direction = inferDirectionFromText([category, item, counterparty].join(' '));
    } else {
      // Unknown value in a column that only has three legal values => the
      // platform changed something. Do not guess.
      warnings.push({
        code: 'unknown-direction-value',
        row: i + 1,
        message: `Unrecognised 收/支 value "${rawDirection}"; row skipped rather than guessed.`,
      });
      continue;
    }

    // A negative figure in the amount column overrides the printed direction.
    if (amountMinor < 0) {
      amountMinor = Math.abs(amountMinor);
      direction = 'out';
    }

    drafts.push({
      source: ALIPAY_SOURCE,
      accountId: options.accountId,
      direction,
      amountMinor,
      currency: 'CNY',
      occurredAt,
      counterparty: counterparty || undefined,
      description: item || category || counterparty || 'Alipay transaction',
      txType: category || undefined,
      method: method || undefined,
      status: status || undefined,
      orderId: record('交易订单号') || undefined,
      merchantOrderId: record('商家订单号') || undefined,
      excludedFromCashflow,
      raw: Object.fromEntries(rawMap),
    });
  }

  return {
    drafts,
    warnings,
    meta: {
      format: 'csv',
      encoding: table.notes.some((n) => n.includes('gbk')) ? 'gbk' : 'auto-detected',
      totalRows: Math.max(0, rows.length - headerRowIndex - 1),
      sourceLabel: 'Alipay',
      templateId: 'alipay',
    },
  };
}
