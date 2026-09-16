/**
 * PDF statement extraction — the highest-risk importer. See AGENTS.md §8.4.
 *
 * A PDF has no columns. It has positioned glyph runs. Rebuilding a table from
 * coordinates can merge two rows into one, or slide an amount into the wrong
 * column, producing figures that look entirely plausible and are wrong. That is
 * strictly more dangerous than failing outright.
 *
 * Therefore this module:
 *   - returns the SAME `Table` shape as the CSV path, so it feeds the identical
 *     generic mapping UI and the identical downstream pipeline (no second
 *     mapping implementation to keep in sync);
 *   - reports a `columnConsistency` ratio so the caller can refuse a bad rebuild;
 *   - never writes to storage itself — the user confirms rows and totals first.
 *
 * ## How rows are rebuilt
 *
 * Gap-based splitting ("a wide horizontal gap starts a new cell") is the obvious
 * first idea and it is wrong for most bank statements, because bank PDF
 * generators pad cells so that every column edge is flush. Every glyph run then
 * touches its neighbour and NOTHING looks like a gap. Worse, those pad runs are
 * themselves glyph runs, so they glue columns together instead of separating them.
 *
 * So the rebuild is two-phase:
 *
 *   1. cluster runs into visual lines by y;
 *   2. locate the table's header line by its wording, and derive COLUMN SPANS
 *      from where its cells sit. Every other line is then bucketed into those
 *      columns by horizontal overlap.
 *
 * Two consequences fall out of that and both matter:
 *
 *   - a cell whose text WRAPS onto a second visual line is not a new row. Such a
 *     line carries nothing in the first column, so it is appended to the row
 *     above. Without this, one 12-column transaction becomes a 12-column row plus
 *     a 1-column fragment, and the fragments wreck both the preview and dedupe.
 *   - a page needs its own header line to be understood. Statements normally
 *     repeat it, but when one does not, the caller passes the previous page's
 *     spans back in — the column geometry is a property of the document, not of
 *     the page.
 *
 * Neither heuristic is allowed to be silent: `extractPdfTable` reports which one
 * was used, and the UI shows the rebuilt rows and totals for confirmation.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { detectHeaderRowIndex, HEADER_KEYWORDS, type Table } from './text';
import { makePdfPasswordRequiredError, PDF_PASSWORD_REQUIRED } from './errors';

/**
 * Re-exported for callers that already depend on this module. The canonical
 * definition lives in `errors.ts`, which imports nothing, so the UI can detect
 * this condition without statically pulling pdf.js into the entry chunk.
 */
export { PDF_PASSWORD_REQUIRED };

export interface PdfExtractionOptions {
  /** Password for encrypted statements (often the last 6 digits of an ID card). */
  password?: string;
  /** Max vertical distance (PDF points) that still counts as the same row. */
  rowTolerance?: number;
  /** Max horizontal gap (PDF points) that still counts as the same cell. */
  columnGap?: number;
  /** Safety valve for enormous documents. */
  maxPages?: number;
}

export interface PdfExtractionResult {
  table: Table;
  pageCount: number;
  pagesRead: number;
  notes: string[];
  /**
   * Share of rows whose cell count differs from the most common cell count.
   * A high value means the rebuild is unreliable and the user must not trust it.
   *
   * Only meaningful for the gap-based fallback: a header-anchored rebuild is
   * rectangular by construction, so it reports `1` even when a value landed in
   * the wrong column. `headerAnchoredColumns` says which builder ran.
   */
  columnConsistency: number;
  /** True when columns came from the header line rather than from gap guessing. */
  headerAnchoredColumns: boolean;
  /** Number of columns in the rebuilt table, or 0 when nothing was recovered. */
  columnCount: number;
}

export const DEFAULT_ROW_TOLERANCE = 3;
export const DEFAULT_COLUMN_GAP = 12;

/**
 * Minimum number of known header words on a line before it is accepted as the
 * table's header. Two, not one: a transaction's own text can easily contain one
 * column-ish word (a merchant called `金额宝`), but two is a strong signal.
 */
export const MIN_HEADER_KEYWORD_HITS = 2;

export interface PositionedTextItem {
  text: string;
  /** Horizontal position, PDF points. */
  x: number;
  /** Vertical position, PDF points. Larger is higher on the page. */
  y: number;
  width: number;
}

/**
 * The horizontal band a column occupies, in PDF points.
 *
 * Spans form a PARTITION of the page: each starts halfway between the previous
 * header cell and this one, and ends halfway between this cell and the next, so
 * the first is open to the left and the last open to the right. No x is left
 * uncovered, which is what makes "assign by greatest overlap" total — a value
 * that overflows its own column still lands somewhere sensible instead of falling
 * through a gap.
 */
export interface ColumnSpan {
  start: number;
  end: number;
}

export interface RebuildOptions {
  rowTolerance?: number;
  columnGap?: number;
  /**
   * Column geometry to use instead of deriving it from this page's header line.
   * Callers pass the previous page's spans when a statement prints its header only
   * on the first page.
   */
  columnSpans?: readonly ColumnSpan[];
}

interface VisualLine {
  /** Baseline y of the line. */
  y: number;
  /** Non-blank runs, left to right. */
  runs: PositionedTextItem[];
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * Join two glyph runs that belong to the same cell.
 *
 * Latin text is space-separated, but inserting a space between two Chinese
 * characters corrupts every merchant name in the file.
 */
export function joinText(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  const a = left.charCodeAt(left.length - 1);
  const b = right.charCodeAt(0);
  return isCjk(a) || isCjk(b) ? left + right : `${left} ${right}`;
}

/**
 * Group runs into visual lines by baseline.
 *
 * Runs that are blank after trimming are dropped up front. They are not neutral:
 * generators pad cells with space runs, so keeping them makes a cell boundary look
 * like contiguous text. Dropping them sharpens the gap fallback and keeps padding
 * out of the assembled cells.
 */
function clusterLines(items: readonly PositionedTextItem[], rowTolerance: number): VisualLine[] {
  const usable = items.filter((item) => item.text.trim() !== '');
  if (usable.length === 0) return [];

  // PDF y grows upward: sort top-to-bottom, then left-to-right.
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: VisualLine[] = [];
  let current: PositionedTextItem[] = [];
  let currentY = sorted[0]!.y;

  const flush = (): void => {
    if (current.length === 0) return;
    lines.push({ y: currentY, runs: [...current].sort((a, b) => a.x - b.x) });
    current = [];
  };

  for (const item of sorted) {
    if (Math.abs(item.y - currentY) > rowTolerance) {
      flush();
      currentY = item.y;
    }
    current.push(item);
  }
  flush();

  return lines;
}

/** Index of the line that reads like a table header, or -1 when none does. */
function findHeaderLineIndex(lines: readonly VisualLine[]): number {
  let best = -1;
  let bestHits = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]!.runs.map((run) => run.text).join(' ');
    const hits = HEADER_KEYWORDS.reduce((n, word) => (text.includes(word) ? n + 1 : n), 0);
    // Strictly greater: the FIRST line wins a tie, so a header repeated on page 2
    // never displaces the real one.
    if (hits > bestHits) {
      bestHits = hits;
      best = i;
    }
  }

  return bestHits >= MIN_HEADER_KEYWORD_HITS ? best : -1;
}

/**
 * Turn a header line into a partition of the page.
 *
 * Header runs within `columnGap` of each other are merged first, because one
 * header cell can be emitted as several glyph runs. Real bank headers leave 20+
 * points between cells, so this never fuses two genuine columns.
 */
function spansFromLine(line: VisualLine, columnGap: number): ColumnSpan[] | null {
  const cells: { left: number; right: number }[] = [];

  for (const run of line.runs) {
    const right = run.x + Math.max(run.width, 0);
    const previous = cells[cells.length - 1];
    if (previous && run.x - previous.right <= columnGap) {
      previous.right = Math.max(previous.right, right);
      continue;
    }
    cells.push({ left: run.x, right });
  }

  if (cells.length < 2) return null;

  return cells.map((cell, i) => {
    const before = cells[i - 1];
    const after = cells[i + 1];
    return {
      start: before ? (before.right + cell.left) / 2 : -Infinity,
      end: after ? (cell.right + after.left) / 2 : Infinity,
    };
  });
}

/** Column whose band overlaps this run most; ties go to the leftmost column. */
function assignColumn(run: PositionedTextItem, spans: readonly ColumnSpan[]): number {
  const left = run.x;
  const right = run.x + Math.max(run.width, 0);

  let best = 0;
  let bestOverlap = -Infinity;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    // A zero-width run scores 0 in the band containing it and negative everywhere
    // else, so containment still wins.
    const overlap = Math.min(right, span.end) - Math.max(left, span.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  return best;
}

function cellsFromLine(line: VisualLine, spans: readonly ColumnSpan[]): string[] {
  const cells = spans.map(() => '');
  for (const run of line.runs) {
    for (const piece of splitRunAcrossColumns(run, spans)) {
      const index = assignColumn(piece, spans);
      cells[index] = joinText(cells[index]!, piece.text);
    }
  }
  return cells.map(placeholderToEmpty);
}

/**
 * Strip the dash run a PDF table uses to mean "this cell is empty".
 *
 * Bank generators do not leave an empty cell blank — they fill it with hyphens
 * sized to the column, so `---------------------------` arrives as real text and
 * ends up as a transaction's description or counterparty. It carries no
 * information, and a value that IS all hyphens (a masked account number) is
 * equally information-free, so folding it to empty is safe either way.
 */
function placeholderToEmpty(cell: string): string {
  const trimmed = cell.trim();
  return /^[-\u2010-\u2015\u2212]+$/.test(trimmed) ? '' : trimmed;
}

/** Relative width of a character, for estimating where text falls inside a run. */
function charWeight(code: number): number {
  return isCjk(code) ? 2 : 1;
}

/**
 * Split a glyph run that holds more than one cell.
 *
 * Generators routinely collapse an empty cell and its right-hand neighbour into
 * ONE text operation, so `------------------- 财付通-拼多多平台商户` arrives as a
 * single run whose extent straddles two or three columns. Assigning that run by
 * overlap puts the whole thing in the first column and leaves the second empty;
 * the neighbouring cell's text then only reappears on the wrap line, so the row
 * reads as `(上海)有限公司` in the wrong field. Splitting at the whitespace that
 * the generator used as the cell separator is the only way back.
 *
 * The pieces' positions are estimated by character weight, because a PDF only
 * reports the run's total width and the glyphs are no longer addressable here.
 * The estimate does not need to be exact — it only has to land each piece in the
 * right column, and the columns are tens of points wide.
 *
 * Only runs whose extent actually crosses a column boundary are split, so a
 * multi-word value that stays inside one column is left intact.
 */
function splitRunAcrossColumns(
  run: PositionedTextItem,
  spans: readonly ColumnSpan[],
): PositionedTextItem[] {
  const width = Math.max(run.width, 0);
  if (width === 0) return [run];

  const left = run.x;
  const right = run.x + width;
  let overlapped = 0;
  for (const span of spans) {
    if (Math.min(right, span.end) - Math.max(left, span.start) > 0) overlapped += 1;
  }
  if (overlapped <= 1) return [run];

  const pieces = [...run.text.matchAll(/\S+/g)];
  if (pieces.length < 2) return [run];

  // UTF-16 indexed on purpose: `matchAll` reports UTF-16 offsets, so weighting
  // must step over the same units or the prefix sums drift.
  const prefix: number[] = [0];
  for (let i = 0; i < run.text.length; i += 1) {
    prefix.push(prefix[i]! + charWeight(run.text.charCodeAt(i)));
  }
  const totalWeight = prefix[prefix.length - 1]!;
  if (totalWeight === 0) return [run];

  return pieces.map((piece) => {
    const start = piece.index ?? 0;
    const startWeight = prefix[start]!;
    const ownWeight = prefix[start + piece[0].length]! - startWeight;
    return {
      text: piece[0],
      x: left + (startWeight / totalWeight) * width,
      y: run.y,
      width: (ownWeight / totalWeight) * width,
    };
  });
}

/** A line that looks like a transaction: something in column 1, and more beside it. */
function isRowLike(cells: readonly string[]): boolean {
  return cells[0]!.trim() !== '' && cells.filter((cell) => cell.trim() !== '').length >= 2;
}

function sameRow(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((cell, i) => cell.trim() === b[i]!.trim());
}

/**
 * Keep the first copy of the table header and drop the rest.
 *
 * Statements repeat their header on every page, so a multi-page rebuild returns
 * it once per page. Left in, the parser reports an unparsable date for each
 * repeat, and the mapping UI shows the header as a transaction.
 *
 * A repeated identical header row is never a transaction, so nothing legitimate
 * is dropped — a real transaction cannot have the words `交易日期` in its date
 * column.
 */
export function dropRepeatedHeaderRows(rows: readonly string[][]): string[][] {
  const headerRowIndex = detectHeaderRowIndex(rows);
  const header = headerRowIndex === -1 ? null : rows[headerRowIndex]!;
  if (!header) return [...rows];
  return rows.filter((row, i) => i === headerRowIndex || !sameRow(row, header));
}

/**
 * Vertical distance between consecutive ROW lines — not between consecutive
 * lines, which would be dominated by the wrapped ones and come out far too small.
 *
 * The median rather than the mean, because the two outliers on every page (the
 * header to the first row, and the last row to the printed footer) are both much
 * larger and would drag a mean upward.
 *
 * @returns `null` when the page does not have two rows to measure between.
 */
function rowPitch(rowLike: readonly boolean[], lines: readonly VisualLine[]): number | null {
  const gaps: number[] = [];
  let previous = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!rowLike[i]) continue;
    if (previous !== -1) gaps.push(lines[previous]!.y - lines[i]!.y);
    previous = i;
  }
  if (gaps.length === 0) return null;

  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1
    ? gaps[middle]!
    : (gaps[middle - 1]! + gaps[middle]!) / 2;
}

/**
 * How far past a row pitch a line may sit and still belong to the table. The
 * printed footer follows the last row after a bigger gap than any row pitch; a
 * wrapped line never does.
 */
export const TABLE_GAP_FACTOR = 1.5;

/**
 * Build rows by bucketing each line into the header's columns.
 *
 * Three things have to be separated here, and all three are decided against the
 * page's own measured row pitch rather than an absolute distance, because font
 * size and leading are the generator's choice:
 *
 *   - a WRAPPED cell line sits closer to the row above than the row pitch, and
 *     carries nothing in the first column. It is appended to that row. Without
 *     this, one transaction becomes a 12-column row plus a fragment, and the
 *     fragments wreck both the preview and dedupe.
 *   - the `END` marker and other printed furniture also carry nothing in the
 *     first column but sit at or beyond a full row pitch. Appending those would
 *     corrupt a real transaction's last fields, so they are skipped.
 *   - the footer note sits more than a row pitch past the table with a much
 *     larger gap, and ends the table. It would otherwise arrive as an
 *     unparsable-date warning on every single page.
 *
 * The cut is refused when it would leave the header alone, so a statement whose
 * leading is nothing like its row pitch degrades to "keep everything" rather than
 * to "lose every transaction".
 *
 * The header line itself IS returned, once per page. Dropping the repeats needs
 * document-wide context, so `extractPdfTable` does it after collecting all pages.
 */
function assembleByColumns(
  lines: readonly VisualLine[],
  spans: readonly ColumnSpan[],
  headerLineIndex: number,
): string[][] {
  const band = lines.slice(headerLineIndex === -1 ? 0 : headerLineIndex);
  if (band.length === 0) return [];

  const cells = band.map((line) => cellsFromLine(line, spans));
  const pitch = rowPitch(cells.map(isRowLike), band);

  let end = band.length - 1;
  if (pitch !== null) {
    const limit = pitch * TABLE_GAP_FACTOR;
    let i = 1;
    while (i < band.length && band[i - 1]!.y - band[i]!.y <= limit) i += 1;
    // `i - 1 > 0` keeps the header plus at least one more line.
    if (i - 1 > 0) end = i - 1;
  }

  const rows: string[][] = [];
  let current: string[] | null = null;

  for (let i = 0; i <= end; i += 1) {
    const line = cells[i]!;
    if (line[0]!.trim() !== '' || current === null) {
      if (current) rows.push(current);
      current = line;
      continue;
    }
    // Printed furniture, not a wrapped cell.
    if (pitch !== null && i > 0 && band[i - 1]!.y - band[i]!.y >= pitch) continue;

    const previous: string[] = current;
    current = line.map((cell, column) =>
      cell === '' ? previous[column]! : joinText(previous[column]!, cell),
    );
  }
  if (current) rows.push(current);

  return rows;
}

/**
 * Fallback for PDFs with no recognisable header: a new cell starts wherever the
 * horizontal gap exceeds `columnGap`. Kept because it is the only thing that works
 * for a simple two-column dump, and because it degrades predictably.
 */
function assembleByGaps(lines: readonly VisualLine[], columnGap: number): string[][] {
  const rows: string[][] = [];

  for (const line of lines) {
    const cells: string[] = [];
    let buffer = '';

    line.runs.forEach((run, i) => {
      if (i === 0) {
        buffer = run.text;
        return;
      }
      const previous = line.runs[i - 1]!;
      const gap = run.x - (previous.x + Math.max(previous.width, 0));
      if (gap > columnGap) {
        cells.push(buffer);
        buffer = run.text;
      } else {
        buffer = joinText(buffer, run.text);
      }
    });
    cells.push(buffer);

    if (cells.some((cell) => cell.trim() !== '')) rows.push(cells.map((cell) => cell.trim()));
  }

  return rows;
}

/**
 * Derive the column geometry of a page from its header line.
 *
 * @returns `null` when the page has no line that reads like a table header, in
 *   which case the caller must fall back to gap splitting.
 */
export function inferColumnSpans(
  items: readonly PositionedTextItem[],
  options: RebuildOptions = {},
): ColumnSpan[] | null {
  const lines = clusterLines(items, options.rowTolerance ?? DEFAULT_ROW_TOLERANCE);
  const headerLineIndex = findHeaderLineIndex(lines);
  if (headerLineIndex === -1) return null;
  return spansFromLine(lines[headerLineIndex]!, options.columnGap ?? DEFAULT_COLUMN_GAP);
}

/**
 * Rebuild visual rows from positioned glyph runs.
 *
 * This is a heuristic, and it is allowed to be wrong — which is exactly why the
 * caller must show the user the resulting rows and the amount total before
 * anything reaches storage.
 */
export function rebuildRows(
  items: readonly PositionedTextItem[],
  options: RebuildOptions = {},
): string[][] {
  const rowTolerance = options.rowTolerance ?? DEFAULT_ROW_TOLERANCE;
  const columnGap = options.columnGap ?? DEFAULT_COLUMN_GAP;

  const lines = clusterLines(items, rowTolerance);
  if (lines.length === 0) return [];

  const headerLineIndex = findHeaderLineIndex(lines);
  const spans =
    options.columnSpans ??
    (headerLineIndex === -1 ? null : spansFromLine(lines[headerLineIndex]!, columnGap));

  if (!spans || spans.length < 2) return assembleByGaps(lines, columnGap);
  return assembleByColumns(lines, spans, headerLineIndex);
}

function isPasswordError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'PasswordException';
}

export async function extractPdfTable(
  bytes: Uint8Array,
  options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
  const rowTolerance = options.rowTolerance ?? DEFAULT_ROW_TOLERANCE;
  const columnGap = options.columnGap ?? DEFAULT_COLUMN_GAP;

  // Both loaded lazily: pdf.js is ~85 KB gzip plus a sizeable worker that would
  // otherwise sit in first paint (AGENTS.md §2.1).
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  let pdfDocument: PDFDocumentProxy;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    ...(options.password ? { password: options.password } : {}),
  });
  try {
    pdfDocument = await loadingTask.promise;
  } catch (error) {
    if (isPasswordError(error)) {
      // Passwords are only ever held in memory (AGENTS.md §3 rule 2).
      throw makePdfPasswordRequiredError();
    }
    throw error;
  }

  const notes: string[] = [];
  const pageCount = pdfDocument.numPages;
  const pagesToRead = Math.min(pageCount, options.maxPages ?? 200);
  if (pagesToRead < pageCount) {
    notes.push(`Only the first ${pagesToRead} of ${pageCount} pages were read.`);
  }

  const allRows: string[][] = [];
  let columnSpans: readonly ColumnSpan[] | null = null;
  let inheritedPages = 0;
  let gapPages = 0;
  let columnCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();

      const items: PositionedTextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const text = raw.str;
        if (text === '') continue;
        const transform = raw.transform as number[];
        items.push({
          text,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: 'width' in raw ? (raw.width as number) : 0,
        });
      }
      page.cleanup();

      // Geometry comes from this page's own header when it prints one, and is
      // otherwise inherited from the last page that did.
      const own = inferColumnSpans(items, { rowTolerance, columnGap });
      if (own) {
        columnSpans = own;
      } else if (columnSpans) {
        inheritedPages += 1;
      } else {
        gapPages += 1;
      }

      // Rebuilt per page, so rows never merge across a page boundary.
      allRows.push(
        ...rebuildRows(items, {
          rowTolerance,
          columnGap,
          ...(columnSpans ? { columnSpans } : {}),
        }),
      );
      if (columnSpans) columnCount = Math.max(columnCount, columnSpans.length);
    }
  } finally {
    await loadingTask.destroy();
  }

  const headerAnchoredColumns = columnSpans !== null;

  const rows = dropRepeatedHeaderRows(allRows);
  const headerRowIndex = detectHeaderRowIndex(rows);

  // ---- Diagnose how even the rebuild is ---------------------------------
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);

  let modalCount = 0;
  let modalFrequency = 0;
  for (const [count, frequency] of counts) {
    if (frequency > modalFrequency) {
      modalFrequency = frequency;
      modalCount = count;
    }
  }

  const consistency = rows.length === 0 ? 0 : modalFrequency / rows.length;

  if (rows.length === 0) {
    notes.push(
      'No text could be extracted. This is likely a scanned/image-only PDF. ' +
        'Please export CSV or XLSX from the bank app instead.',
    );
  } else if (headerAnchoredColumns) {
    notes.push(
      `Columns were taken from the header row (${columnCount} columns) and every value was placed by ` +
        'horizontal overlap rather than by guessing at gaps.' +
        (inheritedPages > 0
          ? ` ${inheritedPages} page(s) printed no header and reused the previous page's columns.`
          : '') +
        (gapPages > 0
          ? ` ${gapPages} page(s) had no header to anchor to, so those pages were split by gap guessing and are less reliable.`
          : '') +
        ' Text that wrapped onto a second line was joined onto the row above. Check a few rows, and the totals, before importing.',
    );
  } else {
    notes.push(
      'No header row could be recognised, so cells were split by gap guessing. ' +
        'Columns that touch each other will be merged into one. Check every row before importing.',
    );
  }

  if (rows.length > 0 && !headerAnchoredColumns && consistency < 0.6) {
    notes.push(
      `Only ${Math.round(consistency * 100)}% of rows have the same number of columns (${modalCount}). ` +
        'The table rebuild is unreliable — check every row before importing.',
    );
  }

  return {
    table: { rows, delimiter: '(pdf)', headerRowIndex, notes },
    pageCount,
    pagesRead: pagesToRead,
    notes,
    columnConsistency: consistency,
    headerAnchoredColumns,
    columnCount,
  };
}
