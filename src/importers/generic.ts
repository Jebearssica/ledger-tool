/**
 * Template-driven generic importer for banks, brokers and anything unknown.
 * See AGENTS.md §8.
 *
 * Design rule: this file contains no institution names. Everything bank-specific
 * lives in a `Template` (a column mapping with a version), so supporting a new
 * bank is a data change, not a code change.
 */
import { parseAmountToMinor } from '../domain/money';
import { combineDateAndTime, toUtcIso } from '../domain/dates';
import type { Direction, DraftTransaction, ParseResult, ParseWarning } from '../domain/types';
import { buildColumnIndex, cellAt, detectHeaderRowIndex, type Table } from './text';
import { headerMismatchError, inferDirectionFromText } from './shared';
import { resolveDirectionValues, validateTemplate, type Template } from './template';

export const GENERIC_SOURCE_PREFIX = 'generic';

/** Markers, seen in some exports, meaning the row is not income or expense. */
const EXCLUDED_MARKERS = ['不计收支', '/', '其他'];

export interface GenericOptions {
  accountId: string;
  /** Overrides the source id; defaults to the template id. */
  source?: string;
}

function resolveHeaderRow(table: Table, template: Template): number {
  if (typeof template.headerRow === 'number' && template.headerRow >= 0) return template.headerRow;
  if (table.headerRowIndex >= 0) return table.headerRowIndex;
  return detectHeaderRowIndex(table.rows);
}

export function parseGeneric(table: Table, template: Template, options: GenericOptions): ParseResult {
  const { rows } = table;
  const warnings: ParseWarning[] = [];

  const headerRowIndex = resolveHeaderRow(table, template);
  if (headerRowIndex === -1) {
    throw new Error(
      `"${template.label}": could not identify a header row. ` +
        `Set the header row explicitly in the template mapping, or check the file.`,
    );
  }

  const header = rows[headerRowIndex] ?? [];
  const validation = validateTemplate(template, header);

  if (!validation.ok) {
    if (validation.noAmountSource) {
      throw new Error(
        `"${template.label}" maps no amount source. Map either a single amount column, or the credit/debit columns.`,
      );
    }
    throw headerMismatchError(`"${template.label}"`, validation.missing, header);
  }

  const columns = buildColumnIndex(header);
  const directionValues = resolveDirectionValues(template);
  const source = options.source ?? template.id;

  const drafts: DraftTransaction[] = [];
  const rawMap = new Map<string, string>();

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.every((c) => c === '')) continue;

    const record = (name: string | undefined): string =>
      name ? cellAt(row, columns.get(name)) : '';

    rawMap.clear();
    header.forEach((name, idx) => {
      if (name !== '') rawMap.set(name, row[idx] ?? '');
    });

    // A statement that splits date and time into two columns needs them put back
    // together, or every row in the file collapses onto midnight.
    const dateText = record(template.columns.date);
    const timeText = template.columns.time ? record(template.columns.time) : '';
    const occurredAt = toUtcIso(combineDateAndTime(dateText, timeText));
    if (!occurredAt) {
      warnings.push({
        code: 'unparsable-date',
        row: i + 1,
        message: `Could not read a date from "${dateText}"; row skipped.`,
      });
      continue;
    }

    const incomeText = record(template.columns.income);
    const expenseText = record(template.columns.expense);
    const amountText = record(template.columns.amount);

    const income = parseAmountToMinor(incomeText);
    const expense = parseAmountToMinor(expenseText);
    const signed = parseAmountToMinor(amountText);

    const incomeAbs = income === null ? 0 : Math.abs(income);
    const expenseAbs = expense === null ? 0 : Math.abs(expense);

    // Distinguish "this cell is empty" from "this cell holds junk". The former
    // is a normal row, the latter means the mapping or the file is wrong and
    // must be reported rather than quietly dropped.
    const isBlankCell = (value: string): boolean => value.trim() === '' || value.trim() === '/';
    const hasUnparsableAmount =
      (income === null && !isBlankCell(incomeText)) || (expense === null && !isBlankCell(expenseText));

    let amountMinor = 0;
    let direction: Direction | null = null;

    // ---- Amount + direction from the column shape -------------------------
    if (template.columns.income || template.columns.expense) {
      if (hasUnparsableAmount) {
        warnings.push({
          code: 'unparsable-amount',
          row: i + 1,
          message:
            `Could not read an amount from 收入="${incomeText}" / 支出="${expenseText}"; row skipped. ` +
            `Check that the template maps the correct columns.`,
        });
        continue;
      }

      if (incomeAbs > 0 && expenseAbs === 0) {
        amountMinor = incomeAbs;
        direction = 'in';
      } else if (expenseAbs > 0 && incomeAbs === 0) {
        amountMinor = expenseAbs;
        direction = 'out';
      } else if (incomeAbs === 0 && expenseAbs === 0) {
        continue; // both sides genuinely empty: nothing happened on this row
      } else {
        // Both sides populated. Guessing here would be exactly the "plausible
        // but wrong amount" failure the spec warns about, so refuse.
        warnings.push({
          code: 'ambiguous-both-sides',
          row: i + 1,
          message:
            `Both "${template.columns.income}" (${incomeText}) and "${template.columns.expense}" (${expenseText}) ` +
            `carry a value; cannot tell income from expense. Row skipped.`,
        });
        continue;
      }
    } else if (signed !== 0 && signed !== null) {
      amountMinor = Math.abs(signed);
      if (signed < 0) direction = 'out';
    } else if (signed === 0 && amountText !== '') {
      continue; // an explicit zero is not a transaction
    }

    if (amountMinor === 0) {
      warnings.push({
        code: 'unparsable-amount',
        row: i + 1,
        message: `Could not read an amount from "${amountText || expenseText || incomeText}"; row skipped.`,
      });
      continue;
    }

    // ---- Explicit direction column wins over the sign ---------------------
    let excludedFromCashflow = false;
    const directionCell = record(template.columns.direction).trim();

    if (directionCell !== '') {
      if (EXCLUDED_MARKERS.includes(directionCell)) {
        excludedFromCashflow = true;
        direction = inferDirectionFromText(
          [record(template.columns.description), record(template.columns.counterparty), record(template.columns.txType)].join(' '),
        );
      } else if (directionValues.in.includes(directionCell)) {
        direction = 'in';
      } else if (directionValues.out.includes(directionCell)) {
        direction = 'out';
      } else {
        warnings.push({
          code: 'unknown-direction-value',
          row: i + 1,
          message:
            `Unrecognised direction value "${directionCell}" (expected one of ${[...directionValues.in, ...directionValues.out].join(', ')}). ` +
            `Falling back to the sign of the amount. Add the value to the template to silence this.`,
        });
      }
    }

    // ---- Sign-based fallback ---------------------------------------------
    if (direction === null) {
      switch (template.amountMode ?? 'signed') {
        case 'signed':
          direction = 'in'; // a positive figure with no direction column
          break;
        case 'positive-is-expense':
          direction = 'out';
          break;
        case 'positive-is-income':
          direction = 'in';
          break;
      }
    }

    const counterparty = record(template.columns.counterparty);
    const description = record(template.columns.description);
    const txType = record(template.columns.txType);

    drafts.push({
      source,
      accountId: options.accountId,
      direction,
      amountMinor,
      currency: 'CNY',
      occurredAt,
      counterparty: counterparty || undefined,
      description: description || txType || counterparty || `${template.label} transaction`,
      txType: txType || undefined,
      method: record(template.columns.method) || undefined,
      status: record(template.columns.status) || undefined,
      orderId: record(template.columns.orderId) || undefined,
      balanceAfterMinor: parseAmountToMinor(record(template.columns.balance)) ?? undefined,
      excludedFromCashflow,
      raw: Object.fromEntries(rawMap),
    });
  }

  return {
    drafts,
    warnings,
    meta: {
      format: 'text',
      encoding: template.encoding ?? 'auto',
      totalRows: Math.max(0, rows.length - headerRowIndex - 1),
      sourceLabel: template.label,
      templateId: template.id,
    },
  };
}
