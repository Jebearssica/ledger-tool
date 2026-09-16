/**
 * Importer facade: bytes in, normalized drafts out. See AGENTS.md §8.
 *
 * Routing is by FORMAT, not by institution:
 *
 *   bytes -> sniff (content, not extension)
 *         -> unwrap .zip if present
 *         -> pdf  : rebuild a table from glyph coordinates
 *            xlsx : read the first sheet
 *            text : decode, guess delimiter, split rows
 *                 -> recognise Alipay / WeChat by their headers
 *                 -> otherwise hand the table to the generic template mapper
 *
 * Nothing here writes to storage, dedupes, or categorises. Those live in
 * `domain/pipeline.ts`, which keeps this layer replayable from fixtures.
 */
import { decodeText, sniff, type ContainerKind } from './sniff';
import { detectHeaderRowIndex, parseDelimited, parseHtmlTable, type Table } from './text';
import { parseAlipay } from './alipay';
import { parseWechat } from './wechat';
import { parseGeneric } from './generic';
import type { Template } from './template';
import type { ParseResult } from '../domain/types';

export type DetectedPlatform = 'alipay' | 'wechat' | null;

/**
 * How the file ended up being read. Deliberately friendlier than
 * `ContainerKind`, which reports what the bytes literally are.
 */
export type InspectionContainer = 'text' | 'html' | 'xlsx' | 'ole-xls' | 'pdf';

export interface Inspection {
  fileName: string;
  container: InspectionContainer;
  /** Human-readable trail of how the file was interpreted. */
  steps: string[];
  notes: string[];
  encoding: string;
  table: Table;
  header: string[];
  detectedPlatform: DetectedPlatform;
  /** Present only for PDFs. */
  pdf?: {
    pageCount: number;
    pagesRead: number;
    columnConsistency: number;
    /** True when columns came from the header row rather than from gap guessing. */
    headerAnchoredColumns: boolean;
    columnCount: number;
  };
}

export interface InspectRequest {
  fileName: string;
  bytes: Uint8Array;
  pdfPassword?: string;
}

export const ARCHIVE_PREFERRED_EXTENSIONS = ['csv', 'xlsx', 'xls', 'txt', 'tsv', 'pdf'] as const;

export const MAX_ARCHIVE_ENTRIES = 500;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function isArchiveJunk(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return (
    name.startsWith('__MACOSX/') ||
    base.startsWith('._') ||
    name.endsWith('/') ||
    base === ''
  );
}

/** Rank archive entries so the statement wins over a readme or a manifest. */
function scoreArchiveEntry(name: string): number {
  const ext = extensionOf(name);
  const preferredIndex = ARCHIVE_PREFERRED_EXTENSIONS.indexOf(
    ext as (typeof ARCHIVE_PREFERRED_EXTENSIONS)[number],
  );
  if (preferredIndex === -1) return -1;

  let score = (ARCHIVE_PREFERRED_EXTENSIONS.length - preferredIndex) * 10;
  const base = (name.split('/').pop() ?? '').toLowerCase();
  if (base.includes('alipay') || base.includes('支付宝')) score += 5;
  if (base.includes('wechat') || base.includes('微信')) score += 5;
  if (base.includes('readme') || base.includes('说明')) score -= 4;
  return score;
}

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  // Loaded lazily: most imports are never archives, and fflate would otherwise
  // sit in the entry chunk for nothing (AGENTS.md §2.1).
  return import('fflate').then(
    ({ unzip }) =>
      new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(data, (error, files) => {
          if (error) reject(error);
          else resolve(files);
        });
      }),
  );
}

async function unwrapArchive(
  bytes: Uint8Array,
  steps: string[],
  notes: string[],
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const files = await unzipAsync(bytes);
  const names = Object.keys(files);

  if (names.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Archive contains ${names.length} entries, which is more than the ${MAX_ARCHIVE_ENTRIES} allowed.`);
  }

  const candidates = names
    .filter((name) => !isArchiveJunk(name))
    .map((name) => ({ name, score: scoreArchiveEntry(name) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    throw new Error(
      `The archive contains no file this tool can read (looked for ${ARCHIVE_PREFERRED_EXTENSIONS.join(', ')}). ` +
        `Entries found: ${names.slice(0, 8).join(', ') || '(none)'}.`,
    );
  }

  const chosen = candidates[0]!;
  steps.push(`Unwrapped archive, using "${chosen.name}".`);
  if (candidates.length > 1) {
    notes.push(`Archive held ${candidates.length} readable files; the highest-scoring one was used. Pick another from the archive if this is wrong.`);
  }

  return { bytes: files[chosen.name]!, fileName: chosen.name };
}

/** Recognise the platform from the header row, not from the file name. */
export function detectPlatform(header: readonly string[]): DetectedPlatform {
  const cells = header.map((c) => c.trim());
  const has = (name: string): boolean => cells.includes(name);

  // Alipay uses 交易分类 / 收付款方式; WeChat uses 交易类型 / 支付方式.
  // The two headers differ by one character, so match exactly.
  if (has('交易分类') || has('收/付款方式')) return 'alipay';
  if (has('交易类型') || has('当前状态') || has('支付方式')) return 'wechat';

  // Fall back to the shared skeleton if only that is present.
  if (has('交易时间') && has('收/支')) {
    if (has('商品说明') || has('对方账号')) return 'alipay';
    if (has('商品') || has('商户单号')) return 'wechat';
  }
  return null;
}

function tableFromDelimitedText(text: string, notes: string[]): Table {
  const first = parseDelimited(text);
  // WeChat CSV embeds tabs inside fields to defeat Excel's auto-conversion.
  // Tabs shift every column, so if any are present in a comma-separated file,
  // re-parse with them removed (AGENTS.md §8.3 rule 2).
  if (first.delimiter !== '\t' && text.includes('\t')) {
    const cleaned = parseDelimited(text, { stripTabs: true, delimiter: first.delimiter });
    notes.push(...cleaned.notes);
    return cleaned;
  }
  notes.push(...first.notes);
  return first;
}

export async function inspectFile(request: InspectRequest): Promise<Inspection> {
  const steps: string[] = [];
  const notes: string[] = [];

  let bytes = request.bytes;
  let fileName = request.fileName;

  let result = sniff(bytes);
  steps.push(`Detected ${result.kind} from file contents (extension was "${extensionOf(fileName) || 'none'}").`);
  notes.push(...result.notes);

  if (result.kind === 'empty') {
    throw new Error('The file is empty.');
  }

  if (result.kind === 'zip') {
    const unwrapped = await unwrapArchive(bytes, steps, notes);
    bytes = unwrapped.bytes;
    fileName = unwrapped.fileName;
    result = sniff(bytes);
    steps.push(`Inner file detected as ${result.kind}.`);
    notes.push(...result.notes);
  }

  // ---- ZIP/OOXML workbook ------------------------------------------------
  if (result.kind === 'zip-ooxml') {
    const { readXlsxSheet } = await import('./xlsx');
    const xlsx = await readXlsxSheet(bytes);
    steps.push(`Read sheet "${xlsx.sheetName}".`);
    notes.push(...xlsx.notes);

    const header = xlsx.table.rows[xlsx.table.headerRowIndex] ?? [];
    return {
      fileName,
      container: 'xlsx',
      steps,
      notes,
      encoding: 'n/a',
      table: xlsx.table,
      header,
      detectedPlatform: detectPlatform(header),
    };
  }

  // ---- Legacy binary .xls ------------------------------------------------
  if (result.kind === 'ole-xls') {
    // A genuine OLE/CFB workbook needs a dedicated reader. Note that most bank
    // files NAMED ".xls" are actually TSV or HTML and are handled below — this
    // branch only fires on the real binary format.
    throw new Error(
      'This is a genuine legacy Excel binary (.xls, OLE/CFB). It is not supported. ' +
        'In your bank app, re-export as CSV or XLSX and import that instead.',
    );
  }

  // ---- PDF ---------------------------------------------------------------
  if (result.kind === 'pdf') {
    const { extractPdfTable } = await import('./pdf');
    const extracted = await extractPdfTable(bytes, {
      ...(request.pdfPassword ? { password: request.pdfPassword } : {}),
    });

    steps.push(`Extracted text from ${extracted.pagesRead}/${extracted.pageCount} page(s), then rebuilt rows from coordinates.`);
    notes.push(...extracted.notes);

    const header = extracted.table.rows[extracted.table.headerRowIndex] ?? [];
    return {
      fileName,
      container: 'pdf',
      steps,
      notes,
      encoding: 'n/a',
      table: extracted.table,
      header,
      detectedPlatform: detectPlatform(header),
      pdf: {
        pageCount: extracted.pageCount,
        pagesRead: extracted.pagesRead,
        columnConsistency: extracted.columnConsistency,
        headerAnchoredColumns: extracted.headerAnchoredColumns,
        columnCount: extracted.columnCount,
      },
    };
  }

  // ---- HTML table (some brokers ship this inside a file named .xls) ------
  if (result.kind === 'html') {
    const rows = parseHtmlTable(result.text ?? '');
    if (rows.length === 0) {
      throw new Error('The file looks like HTML but no table rows could be extracted.');
    }
    steps.push(`Parsed an HTML table with ${rows.length} row(s).`);

    const table: Table = { rows, delimiter: '(html)', headerRowIndex: detectHeaderRowIndex(rows), notes: [] };
    const header = rows[table.headerRowIndex] ?? [];
    return {
      fileName,
      container: 'html',
      steps,
      notes,
      encoding: result.encoding ?? 'utf-8',
      table,
      header,
      detectedPlatform: detectPlatform(header),
    };
  }

  // ---- Delimited text ----------------------------------------------------
  const table = tableFromDelimitedText(result.text ?? '', notes);
  steps.push(`Split into ${table.rows.length} row(s) using delimiter "${table.delimiter}".`);

  if (table.headerRowIndex === -1) {
    throw new Error(
      'Could not find a header row. The file may not be a statement, or its header uses unfamiliar wording. ' +
        'Map the columns manually to proceed.',
    );
  }

  const header = table.rows[table.headerRowIndex] ?? [];
  const detectedPlatform = detectPlatform(header);
  steps.push(
    detectedPlatform
      ? `Recognised a ${detectedPlatform} export from its column headers.`
      : 'Not a recognised platform export; a column mapping template is required.',
  );

  return {
    fileName,
    container: 'text',
    steps,
    notes,
    encoding: result.encoding ?? 'utf-8',
    table,
    header,
    detectedPlatform,
  };
}

export interface ParseInspectedOptions {
  accountId: string;
  /** Required when the platform was not recognised. */
  template?: Template;
  /** Force a specific importer when detection is wrong. */
  force?: 'alipay' | 'wechat' | 'generic';
}

export function parseInspected(
  inspection: Inspection,
  options: ParseInspectedOptions,
): ParseResult {
  const choice = options.force ?? inspection.detectedPlatform ?? 'generic';
  const { table } = inspection;

  switch (choice) {
    case 'alipay':
      return parseAlipay(table, { accountId: options.accountId });

    case 'wechat':
      return parseWechat(table, {
        accountId: options.accountId,
        format: inspection.container === 'xlsx' ? 'xlsx' : 'csv',
      });

    case 'generic': {
      if (!options.template) {
        throw new Error(
          `No built-in importer matched this file, so a column mapping is needed. ` +
            `Columns found: ${inspection.header.filter((c) => c !== '').join(' | ')}.`,
        );
      }
      return parseGeneric(table, options.template, { accountId: options.accountId });
    }
  }
}

export { sniff, decodeText, parseDelimited, parseHtmlTable, parseAlipay, parseWechat, parseGeneric };
export type { ContainerKind, Table, Template };
