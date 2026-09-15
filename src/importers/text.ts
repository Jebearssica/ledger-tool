/**
 * Delimited-text and HTML-table parsing. See AGENTS.md §8.3.
 *
 * Two rules from the spec are enforced here rather than at call sites, because
 * forgetting them produces plausible-looking but wrong numbers:
 *   - header rows are FOUND by scanning, never hardcoded to a line number;
 *   - WeChat's stray tab characters are stripped before parsing, or columns shift.
 */
import Papa from 'papaparse';

export interface Table {
  rows: string[][];
  delimiter: string;
  /** Index of the detected header row, or -1 when none was found. */
  headerRowIndex: number;
  notes: string[];
}

/** Header cells that appear in real Chinese bank and platform exports. */
const HEADER_KEYWORDS = [
  '交易时间',
  '交易日期',
  '记账日期',
  '交易日',
  '交易金额',
  '发生额',
  '本币金额',
  '收/支',
  '收支',
  '交易类型',
  '交易状态',
  '当前状态',
  '交易对方',
  '对方户名',
  '对方账号',
  '商户',
  '商品',
  '摘要',
  '备注',
  '余额',
  '借/贷',
  '借方',
  '贷方',
  '收入',
  '支出',
];

export function trimCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').trim();
}

/**
 * Parse delimited text into a rectangular array.
 *
 * @param stripTabs Remove every tab before parsing. Required for WeChat CSV,
 *   where tabs are injected to stop Excel auto-converting long order numbers.
 *   Only safe when the delimiter is not a tab.
 */
export function parseDelimited(
  text: string,
  options: { delimiter?: string; stripTabs?: boolean; requireHeader?: string } = {},
): Table {
  const notes: string[] = [];
  const guessedDelimiter = options.delimiter ?? '';

  let source = text;
  if (options.stripTabs) {
    if (guessedDelimiter === '\t') {
      throw new Error(
        'Refusing to strip tabs from a tab-separated file: that would destroy the column boundaries.',
      );
    }
    source = source.split('\t').join('');
    notes.push('Removed tab characters before parsing (export quirk).');
  }

  /**
   * Normalise line endings to a single LF, and only then parse.
   *
   * This is not cosmetic — Papa Parse detects the line break from the FIRST one
   * it encounters and then applies it to the entire input. Real Alipay exports
   * write the preamble with CRLF and every data row with a bare LF, so detection
   * latches onto CRLF and the whole body is swallowed into ONE row, producing a
   * handful of "rows" whose first entry is the header plus every transaction.
   * That failure is silent: parsing "succeeds" and yields zero usable records.
   *
   * Normalising first also covers CRLF-only and legacy bare-CR files.
   */
  const crlfCount = (source.match(/\r\n/g) ?? []).length;
  const lfCount = (source.match(/\n/g) ?? []).length;
  const hasBareCr = /\r(?!\n)/.test(source);

  if (crlfCount > 0 || hasBareCr) {
    const bareLf = lfCount - crlfCount;
    if (crlfCount > 0 && bareLf > 0) {
      notes.push('Mixed line endings (CRLF and LF) detected; normalised to LF before parsing.');
    }
    source = source.replace(/\r\n?/g, '\n');
  }

  const parsed = Papa.parse<string[]>(source, {
    delimiter: guessedDelimiter,
    // Explicit, because the input is already normalised and autodetection is
    // exactly what went wrong above.
    newline: '\n',
    skipEmptyLines: 'greedy',
  });

  const rows = (parsed.data ?? []).map((row) => (Array.isArray(row) ? row.map(trimCell) : []));
  const delimiter = guessedDelimiter !== '' ? guessedDelimiter : (parsed.meta.delimiter ?? ',');

  const headerRowIndex = options.requireHeader
    ? findHeaderRowIndex(rows, options.requireHeader)
    : detectHeaderRowIndex(rows);

  if (options.requireHeader && headerRowIndex === -1) {
    throw new Error(
      `Could not find a header row containing "${options.requireHeader}". ` +
        `Actual first rows: ${describeRows(rows, 3)}`,
    );
  }

  return { rows, delimiter, headerRowIndex, notes };
}

/** Locate the row whose cells contain an exact (trimmed) header name. */
export function findHeaderRowIndex(rows: readonly string[][], headerName: string): number {
  for (let i = 0; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells) continue;
    if (cells.some((cell) => cell === headerName)) return i;
  }
  return -1;
}

/**
 * Find the row that looks like a header.
 *
 * Scoring rewards known header keywords heavily and non-empty cells lightly, so
 * a wide data row cannot outrank a genuine (narrower) header row. The minimum
 * width is two cells rather than three so that a genuinely two-column statement
 * (date + amount) is still recognised.
 */
export function detectHeaderRowIndex(rows: readonly string[][]): number {
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, 40);

  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i];
    if (!cells) continue;
    const nonEmpty = cells.filter((c) => c !== '').length;
    if (nonEmpty < 2) continue;

    const keywordHits = cells.filter((c) => HEADER_KEYWORDS.some((k) => c.includes(k))).length;
    const score = keywordHits * 10 + nonEmpty;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Index a header row by column name. Duplicate names keep the first occurrence. */
export function buildColumnIndex(header: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (name !== '' && !index.has(name)) index.set(name, i);
  });
  return index;
}

export function cellAt(row: readonly string[] | undefined, index: number | undefined): string {
  if (!row || index === undefined || index < 0 || index >= row.length) return '';
  return row[index] ?? '';
}

/** Trim, drop rows that are entirely empty, and pad nothing. */
export function normalizeRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.map((row) => row.map(trimCell)).filter((row) => row.some((c) => c !== ''));
}

function describeRows(rows: readonly string[][], count: number): string {
  return rows
    .slice(0, count)
    .map((row, i) => `#${i + 1}[${row.slice(0, 6).join(' | ')}]`)
    .join(' ');
}

const ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const known = ENTITY_MAP[match.toLowerCase()];
    if (known !== undefined) return known;

    if (entity.toLowerCase().startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

/**
 * Extract an HTML table without a DOM.
 *
 * A hand-rolled parser is used deliberately: this must work identically in the
 * browser, in Vitest under `environment: 'node'` (no DOMParser), and on a file
 * that some bank decided to name `.xls`.
 */
export function parseHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const body = rowMatch[1] ?? '';
    const cells: string[] = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;

    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(body)) !== null) {
      cells.push(trimCell(stripTags(cellMatch[1] ?? '')));
    }
    if (cells.length > 0) rows.push(cells);
  }

  return rows;
}
