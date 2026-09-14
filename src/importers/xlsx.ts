/**
 * XLSX reader — a thin adapter, loaded lazily. See AGENTS.md §2.1, §8.1.
 *
 * Library choice, with measured numbers (Bundlephobia, gzip):
 *   - `exceljs`            256 KB, and resolves to a Node entry that needs
 *                          `Buffer`/`stream` polyfills in Vite.
 *   - `xlsx` (SheetJS)     140 KB, but the npm package is abandoned with two
 *                          High CVEs whose npm "patched versions" are `None`.
 *   - `read-excel-file`     11 KB, MIT, browser-first, no polyfills, and it
 *                          already depends on `fflate` which we ship anyway.
 *
 * Because this is only ever reached through `import()`, none of it affects
 * first paint — but 11 KB vs 256 KB still matters for a mobile install.
 *
 * Note the import path: this package exports no `.` entry, so the bare
 * specifier does not resolve. `/universal` accepts `Blob | ArrayBuffer` and
 * works identically in the browser and in Node-based tests.
 */
import { detectHeaderRowIndex, type Table } from './text';

export interface XlsxReadResult {
  table: Table;
  sheetName: string;
  sheetNames: string[];
  notes: string[];
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Fallback for cells the library hands back as `Date` rather than a string. */
function formatDateCell(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0;
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  return hasTime ? `${date} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}` : date;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDateCell(value);
  if (typeof value === 'number') {
    // Guard against exponent notation for very large integers (order numbers).
    return Number.isInteger(value) && Math.abs(value) < 1e21 ? value.toFixed(0) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Read a workbook into the same `Table` shape the CSV path produces, so every
 * downstream importer and the generic mapping UI work unchanged.
 */
export async function readXlsxSheet(
  bytes: Uint8Array,
  options: { sheetIndex?: number } = {},
): Promise<XlsxReadResult> {
  const { default: readXlsxFile } = await import('read-excel-file/universal');

  const sheets = await readXlsxFile(toArrayBuffer(bytes), {
    // Asking for a string avoids Date-constructor timezone ambiguity entirely.
    dateFormat: 'yyyy-mm-dd hh:mm:ss',
  });

  if (sheets.length === 0) {
    throw new Error('The workbook contains no sheets.');
  }

  const index = options.sheetIndex ?? 0;
  const chosen = sheets[index] ?? sheets[0]!;
  const sheetNames = sheets.map((s) => s.sheet);
  const notes: string[] = [];

  if (sheets.length > 1) {
    notes.push(
      `Workbook has ${sheets.length} sheets (${sheetNames.join(', ')}); using "${chosen.sheet}".`,
    );
  }

  const rows = chosen.data.map((row) => row.map(cellToString));
  const headerRowIndex = detectHeaderRowIndex(rows);

  return {
    table: { rows, delimiter: '(xlsx)', headerRowIndex, notes },
    sheetName: chosen.sheet,
    sheetNames,
    notes,
  };
}
