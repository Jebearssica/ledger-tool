/**
 * Content-based format detection. See AGENTS.md §8.1.
 *
 * Extension is NOT a reliable signal. Brokerages and banks routinely ship files
 * named `.xls` that are actually TSV text or an HTML table, and platforms wrap
 * everything in `.zip`. Sniff the bytes instead.
 */

export type ContainerKind = 'zip-ooxml' | 'zip' | 'ole-xls' | 'pdf' | 'html' | 'text' | 'empty';

export interface SniffResult {
  kind: ContainerKind;
  /** Decoded text, present only when `kind` is `text` or `html`. */
  text?: string;
  /** Encoding that successfully decoded the bytes. */
  encoding?: string;
  /** Best guess at the field separator, for delimited text. */
  delimiter?: string;
  /** Machine-readable notes shown to the user in the import summary. */
  notes: string[];
}

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .xls (CFB)
/** OOXML workbooks always carry this part; its presence distinguishes xlsx from a plain zip. */
const OOXML_MARKER = '[Content_Types].xml';

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** Search within a bounded prefix — the marker always appears early, and this keeps sniffing O(1). */
function containsAscii(bytes: Uint8Array, needle: string, limit = 8192): boolean {
  const end = Math.min(bytes.length, limit);
  const n = needle.length;
  if (n === 0 || end < n) return false;
  outer: for (let i = 0; i <= end - n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode bytes to text, preferring strict UTF-8.
 *
 * Strict decoding is what makes the fallback safe: `fatal: true` throws on
 * malformed UTF-8, which is exactly the signal that the file is GBK. A lenient
 * UTF-8 decode would instead produce mojibake that then parses "successfully"
 * into garbage merchant names.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8' };

  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8' };
  } catch {
    // Not valid UTF-8. Chinese platform exports are overwhelmingly GBK.
  }

  try {
    return { text: stripBom(new TextDecoder('gbk').decode(bytes)), encoding: 'gbk' };
  } catch {
    return { text: stripBom(new TextDecoder('utf-8').decode(bytes)), encoding: 'utf-8-replacement' };
  }
}

export type Delimiter = ',' | '\t' | ';';

/** Compare comma / tab / semicolon counts on the first few populated lines. */
export function guessDelimiter(text: string): Delimiter {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  const counts: Record<Delimiter, number> = { ',': 0, '\t': 0, ';': 0 };

  for (const line of lines) {
    counts[','] += (line.match(/,/g) ?? []).length;
    counts['\t'] += (line.match(/\t/g) ?? []).length;
    counts[';'] += (line.match(/;/g) ?? []).length;
  }

  let best: Delimiter = ',';
  for (const candidate of [',', '\t', ';'] as const) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

export function sniff(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) {
    return { kind: 'empty', notes: ['File is empty.'] };
  }

  if (startsWith(bytes, PDF)) {
    return { kind: 'pdf', notes: ['PDF container. Text is extracted from coordinates, then table rows are rebuilt.'] };
  }

  if (startsWith(bytes, OLE)) {
    return { kind: 'ole-xls', notes: ['Legacy OLE/CFB Excel workbook (D0 CF 11 E0).'] };
  }

  if (startsWith(bytes, ZIP_LOCAL) || startsWith(bytes, ZIP_EMPTY)) {
    if (containsAscii(bytes, OOXML_MARKER)) {
      return { kind: 'zip-ooxml', notes: ['OOXML workbook (.xlsx).'] };
    }
    return { kind: 'zip', notes: ['ZIP archive. The first document inside will be used.'] };
  }

  const { text, encoding } = decodeText(bytes);
  const head = text.slice(0, 4096).toLowerCase();
  const notes: string[] = [`Decoded as ${encoding}.`];

  if (/<table[\s>]/.test(head) || (/^\s*<(!doctype|html)/.test(head) && /<\/t[dh]>/.test(head))) {
    notes.push('Looks like an HTML table, which is what some brokers ship inside a file named ".xls".');
    return { kind: 'html', text, encoding, notes };
  }

  const delimiter = guessDelimiter(text);
  if (delimiter === '\t') {
    notes.push('Tab-separated. Tab-delimited data named ".xls" is common in brokerage exports.');
  }

  return { kind: 'text', text, encoding, delimiter, notes };
}
