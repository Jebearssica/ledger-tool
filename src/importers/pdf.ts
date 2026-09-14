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
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { detectHeaderRowIndex, type Table } from './text';
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
   */
  columnConsistency: number;
}

export const DEFAULT_ROW_TOLERANCE = 3;
export const DEFAULT_COLUMN_GAP = 12;

export interface PositionedTextItem {
  text: string;
  /** Horizontal position, PDF points. */
  x: number;
  /** Vertical position, PDF points. Larger is higher on the page. */
  y: number;
  width: number;
}

export interface RebuildOptions {
  rowTolerance?: number;
  columnGap?: number;
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
 * Rebuild visual rows from positioned glyph runs.
 *
 * Two passes:
 *   1. cluster by y (within `rowTolerance`) to recover rows;
 *   2. within each row, start a new cell whenever the horizontal gap exceeds
 *      `columnGap`.
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

  const usable = items.filter((item) => item.text !== '');
  if (usable.length === 0) return [];

  // PDF y grows upward: sort top-to-bottom, then left-to-right.
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: string[][] = [];
  let current: PositionedTextItem[] = [];
  let currentY = sorted[0]!.y;

  const flush = (): void => {
    if (current.length === 0) return;

    const ordered = [...current].sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let buffer = '';

    for (let i = 0; i < ordered.length; i += 1) {
      const item = ordered[i]!;
      if (i === 0) {
        buffer = item.text;
        continue;
      }
      const previous = ordered[i - 1]!;
      const gap = item.x - (previous.x + previous.width);
      if (gap > columnGap) {
        cells.push(buffer);
        buffer = item.text;
      } else {
        buffer = joinText(buffer, item.text);
      }
    }
    cells.push(buffer);

    if (cells.some((c) => c.trim() !== '')) rows.push(cells.map((c) => c.trim()));
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

  return rows;
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

      // Rebuilt per page, so rows never merge across a page boundary.
      allRows.push(...rebuildRows(items, { rowTolerance, columnGap }));
    }
  } finally {
    await loadingTask.destroy();
  }

  // ---- Diagnose how even the rebuild is ---------------------------------
  const counts = new Map<number, number>();
  for (const row of allRows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);

  let modalCount = 0;
  let modalFrequency = 0;
  for (const [count, frequency] of counts) {
    if (frequency > modalFrequency) {
      modalFrequency = frequency;
      modalCount = count;
    }
  }

  const consistency = allRows.length === 0 ? 0 : modalFrequency / allRows.length;

  if (allRows.length === 0) {
    notes.push(
      'No text could be extracted. This is likely a scanned/image-only PDF. ' +
        'Please export CSV or XLSX from the bank app instead.',
    );
  } else if (consistency < 0.6) {
    notes.push(
      `Only ${Math.round(consistency * 100)}% of rows have the same number of columns (${modalCount}). ` +
        'The table rebuild is unreliable — check every row before importing.',
    );
  }

  const headerRowIndex = detectHeaderRowIndex(allRows);

  return {
    table: { rows: allRows, delimiter: '(pdf)', headerRowIndex, notes },
    pageCount,
    pagesRead: pagesToRead,
    notes,
    columnConsistency: consistency,
  };
}
