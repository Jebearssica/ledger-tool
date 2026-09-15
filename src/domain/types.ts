/**
 * Core domain model. See AGENTS.md §4.
 *
 * Two invariants are enforced by these types and must never be relaxed:
 *   1. Money is ALWAYS an integer count of minor units (fen), never a float.
 *   2. Timestamps are ALWAYS UTC ISO-8601 strings; localisation happens at render.
 */

export type Direction = 'in' | 'out';

/**
 * `transfer-repayment` exists because "spending" and "repaying the spending" are
 * not the same event. A Huabei / credit-card purchase is a real expense; the
 * later repayment merely clears a liability. Recording both would double-count.
 * See AGENTS.md §6.1.
 */
export type TransactionKind =
  | 'expense'
  | 'income'
  | 'transfer-internal'
  | 'transfer-investment'
  | 'transfer-repayment'
  | 'refund'
  | 'unknown';

export type CategorySource = 'rule' | 'user' | 'none';

/** An importer identifier, e.g. `alipay`, `wechat`, or a generic template id. */
export type Source = string;

export type SupportedExtension = 'csv' | 'txt' | 'tsv' | 'xls' | 'xlsx' | 'pdf';

export const SUPPORTED_EXTENSIONS: readonly SupportedExtension[] = [
  'csv',
  'txt',
  'tsv',
  'xls',
  'xlsx',
  'pdf',
];

/**
 * A single row as read from a statement, before any cross-row reasoning.
 *
 * Importers produce these and nothing else: they must not categorise, dedupe,
 * assign `kind`, or touch storage. That keeps them pure and replayable, and it
 * means the same fixture can be used to test parsing and business rules apart.
 */
export interface DraftTransaction {
  source: Source;
  accountId: string;
  direction: Direction;
  /** Integer minor units. Never a float. */
  amountMinor: number;
  /** ISO-4217, e.g. `CNY`. */
  currency: string;
  /** UTC ISO-8601. */
  occurredAt: string;
  counterparty?: string;
  /** Original text, never rewritten. Categorisation is derived data. */
  description: string;
  balanceAfterMinor?: number;
  status?: string;
  orderId?: string;
  merchantOrderId?: string;
  method?: string;
  /** Platform-specific transaction type, e.g. WeChat `交易类型`. */
  txType?: string;
  /**
   * True when the platform itself already states the row does not affect
   * income/expense (Alipay `不计收支`, WeChat `收/支 = "/"`).
   *
   * Trust this flag over keyword guessing — both platforms emit it natively,
   * and keyword heuristics produce false positives. See AGENTS.md §6.1.
   */
  excludedFromCashflow: boolean;
  /** Verbatim source fields, kept for auditing and for template debugging. */
  raw: Record<string, string>;
  /**
   * Set by the pipeline, NEVER by an importer.
   *
   * When a partial refund was netted against this row, `amountMinor` has already
   * been reduced by this many minor units. `amountMinor + refundNettedMinor` is
   * therefore the figure printed on the statement.
   *
   * The fingerprint deliberately uses that pre-adjustment figure: two overlapping
   * exports of the same period (a monthly file and a yearly file) must still
   * produce the same fingerprint even when only one of them carries the refund
   * row, otherwise the purchase would be imported twice. See AGENTS.md §5.
   */
  refundNettedMinor?: number;
}

/** A deduplicated, categorised, persisted record. */
export interface Transaction {
  id: string;
  fingerprint: string;
  fingerprintVersion: number;
  source: Source;
  accountId: string;
  direction: Direction;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  counterparty?: string;
  balanceAfterMinor?: number;
  rawDescription: string;
  category?: string;
  categorySource: CategorySource;
  kind: TransactionKind;
  importedBatchId: string;
  sourceOrderId?: string;
  meta?: Record<string, string>;
}

export interface ParseWarning {
  code: string;
  message: string;
  /** 1-based line number in the source file, when known. */
  row?: number;
}

export interface ParseMeta {
  /** Container actually used, e.g. `csv` even when the file was `report.xls`. */
  format: string;
  encoding: string;
  /** Rows read from the file before any filtering. */
  totalRows: number;
  sourceLabel: string;
  /** Template id and version, when a template drove the parse. */
  templateId?: string;
}

export interface ParseResult {
  drafts: DraftTransaction[];
  warnings: ParseWarning[];
  meta: ParseMeta;
}

/** Kinds that count toward real income and expense. */
export const CASHFLOW_KINDS: ReadonlySet<TransactionKind> = new Set<TransactionKind>([
  'expense',
  'income',
]);

/** Kinds that are movements between the user's own accounts, not spending. */
export const TRANSFER_KINDS: ReadonlySet<TransactionKind> = new Set<TransactionKind>([
  'transfer-internal',
  'transfer-investment',
  'transfer-repayment',
]);
