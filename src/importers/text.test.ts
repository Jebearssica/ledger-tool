import { describe, expect, it } from 'vitest';
import { parseDelimited, detectHeaderRowIndex, parseHtmlTable } from './text';

describe('parseDelimited — line endings', () => {
  /**
   * The bug this guards against, reproduced from a real Alipay export:
   * the preamble is written with CRLF and every data row with a bare LF.
   *
   * Papa Parse detects the line break from the FIRST one it sees and then
   * applies it to the whole input, so it latches onto CRLF and swallows the
   * entire body into a single row. Parsing "succeeds", reports a handful of
   * rows, and yields zero usable records — a silent total failure.
   */
  it('parses a file whose preamble is CRLF and whose data is LF', () => {
    const mixed =
      'preamble one\r\n' +
      'preamble two\r\n' +
      '交易时间,交易分类,金额\r\n' + // header on a CRLF line, as the real file has
      '2026-09-01 08:00:00,餐饮美食,28.50\n' +
      '2026-09-02 09:00:00,交通出行,45.00\n' +
      '2026-09-03 10:00:00,日用百货,56.80\n';

    const table = parseDelimited(mixed);

    expect(table.rows).toHaveLength(6);
    expect(table.headerRowIndex).toBe(2);
    expect(table.rows[5]).toEqual(['2026-09-03 10:00:00', '日用百货', '56.80']);
    expect(table.notes.join(' ')).toMatch(/Mixed line endings/i);
  });

  it('parses an all-CRLF file', () => {
    const crlf = '交易时间,金额\r\n2026-09-01,28.50\r\n2026-09-02,45.00\r\n';
    const table = parseDelimited(crlf);

    expect(table.rows).toHaveLength(3);
    expect(table.headerRowIndex).toBe(0);
    // A trailing CR must not survive into the last cell.
    expect(table.rows[1]).toEqual(['2026-09-01', '28.50']);
  });

  it('parses an all-LF file', () => {
    const lf = '交易时间,金额\n2026-09-01,28.50\n2026-09-02,45.00\n';
    const table = parseDelimited(lf);

    expect(table.rows).toHaveLength(3);
    expect(table.rows[2]).toEqual(['2026-09-02', '45.00']);
  });

  it('parses a legacy bare-CR file', () => {
    const cr = '交易时间,金额\r2026-09-01,28.50\r2026-09-02,45.00\r';
    const table = parseDelimited(cr);

    expect(table.rows).toHaveLength(3);
    expect(table.rows[1]).toEqual(['2026-09-01', '28.50']);
  });

  it('does not report mixed endings for a uniform file', () => {
    const crlf = '趋势\r\n交易时间,金额\r\n2026-09-01,28.50\r\n';
    expect(parseDelimited(crlf).notes.join(' ')).not.toMatch(/Mixed/i);
  });

  it('keeps tab stripping working alongside normalisation', () => {
    const withTabs = '交易时间,金额\r\n2026-09-01,\t28.50\n2026-09-02,45.00\n';
    const table = parseDelimited(withTabs, { stripTabs: true });

    expect(table.rows).toHaveLength(3);
    expect(table.rows[1]).toEqual(['2026-09-01', '28.50']);
  });

  it('still finds the header after normalisation', () => {
    const mixed = 'a\r\nb\r\n交易时间,金额\n2026-09-01,28.50\n';
    const table = parseDelimited(mixed);
    expect(table.headerRowIndex).toBe(2);
    expect(detectHeaderRowIndex(table.rows)).toBe(2);
  });
});

describe('parseHtmlTable', () => {
  it('extracts rows and decodes entities', () => {
    const html =
      '<table><tr><td>交易时间</td><td>金额</td></tr>' +
      '<tr><td>2026-09-01</td><td>&yen;28.50</td></tr></table>';
    const rows = parseHtmlTable(html);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['交易时间', '金额']);
    expect(rows[1]?.[0]).toBe('2026-09-01');
  });
});
