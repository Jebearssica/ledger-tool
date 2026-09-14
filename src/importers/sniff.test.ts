import { describe, expect, it } from 'vitest';
import { decodeText, guessDelimiter, sniff } from './sniff';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 交易时间 encoded as GBK, which is what Alipay actually ships. */
const GBK_JIAOYI_SHIJIAN = new Uint8Array([0xbd, 0xbb, 0xd2, 0xd7, 0xca, 0xb1, 0xbc, 0xe4]);

describe('sniff — container detection by content, not extension', () => {
  it('detects a PDF', () => {
    expect(sniff(utf8('%PDF-1.7\n...')).kind).toBe('pdf');
  });

  it('detects a legacy OLE workbook', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    expect(sniff(ole).kind).toBe('ole-xls');
  });

  it('distinguishes an OOXML workbook from a plain archive', () => {
    // Both are ZIPs; only the workbook carries [Content_Types].xml.
    const plainZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(sniff(plainZip).kind).toBe('zip');

    const ooxml = utf8('PK\x03\x04.....[Content_Types].xml......');
    expect(sniff(ooxml).kind).toBe('zip-ooxml');
  });

  it('detects an HTML table, which brokers often ship as .xls', () => {
    const html = '<html><body><table><tr><td>交易时间</td><td>金额</td></tr></table></body></html>';
    const result = sniff(utf8(html));
    expect(result.kind).toBe('html');
    expect(result.notes.join(' ')).toContain('HTML');
  });

  it('treats everything else as delimited text', () => {
    expect(sniff(utf8('a,b,c\n1,2,3')).kind).toBe('text');
  });

  it('handles an empty file without throwing', () => {
    expect(sniff(new Uint8Array(0)).kind).toBe('empty');
  });
});

describe('decodeText', () => {
  it('decodes UTF-8, including Chinese', () => {
    const result = decodeText(utf8('交易时间,金额'));
    expect(result.text).toBe('交易时间,金额');
    expect(result.encoding).toBe('utf-8');
  });

  it('falls back to GBK when the bytes are not valid UTF-8', () => {
    // A lenient UTF-8 decode would produce mojibake that then "parses" into
    // garbage merchant names, so strict decoding is what makes this safe.
    const result = decodeText(GBK_JIAOYI_SHIJIAN);
    expect(result.text).toBe('交易时间');
    expect(result.encoding).toBe('gbk');
  });

  it('strips a UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('交易时间')]);
    expect(decodeText(withBom).text).toBe('交易时间');
  });

  it('handles empty input', () => {
    expect(decodeText(new Uint8Array(0)).text).toBe('');
  });
});

describe('guessDelimiter', () => {
  it('recognises commas, tabs and semicolons', () => {
    expect(guessDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(guessDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(guessDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('prefers commas when a comma-separated file merely contains a few tabs', () => {
    // This matters: WeChat injects one tab per row to keep order ids as text,
    // and mistaking the file for tab-separated would destroy every column.
    const wechatish = 'a,b,c,d\n\t1,2,3,4\n\t5,6,7,8';
    expect(guessDelimiter(wechatish)).toBe(',');
  });

  it('defaults to a comma for a single-column file', () => {
    expect(guessDelimiter('just one column\nand another')).toBe(',');
  });
});
