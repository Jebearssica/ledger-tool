import { describe, expect, it } from 'vitest';
import { dropRepeatedHeaderRows, inferColumnSpans, joinText, rebuildRows, type PositionedTextItem } from './pdf';
import { BOC_DEBIT_PDF_TEMPLATE } from './template';
import { parseGeneric } from './generic';
import { detectHeaderRowIndex, type Table } from './text';
import {
  BOC_FIXTURE_ROWS,
  bocFixturePages,
  bocPrintedTotals,
  type BocRow,
} from '../tests/fixtures/bocPdf';

/** Build a glyph run at a position; width defaults to a plausible glyph box. */
function glyph(text: string, x: number, y: number, width = 20): PositionedTextItem {
  return { text, x, y, width };
}

describe('joinText', () => {
  it('does not insert a space between Chinese characters', () => {
    // Inserting a space here would corrupt every merchant name in the file.
    expect(joinText('示例', '餐厅')).toBe('示例餐厅');
  });

  it('inserts a space between Latin runs', () => {
    expect(joinText('Example', 'Shop')).toBe('Example Shop');
  });

  it('handles empty operands', () => {
    expect(joinText('', '餐厅')).toBe('餐厅');
    expect(joinText('示例', '')).toBe('示例');
  });
});

describe('rebuildRows — row clustering', () => {
  it('groups glyphs that share a baseline', () => {
    const rows = rebuildRows([
      glyph('交易时间', 10, 700),
      glyph('金额', 200, 700),
      glyph('2026-09-14', 10, 680),
      glyph('28.50', 200, 680),
    ]);

    expect(rows).toEqual([
      ['交易时间', '金额'],
      ['2026-09-14', '28.50'],
    ]);
  });

  it('tolerates small vertical jitter within one row', () => {
    const rows = rebuildRows([
      glyph('交易时间', 10, 700),
      glyph('金额', 200, 698.5),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('separates rows once the gap exceeds the tolerance', () => {
    const rows = rebuildRows(
      [glyph('第一行', 10, 700), glyph('第二行', 10, 690)],
      { rowTolerance: 3 },
    );
    expect(rows).toHaveLength(2);
  });

  it('sorts rows top-to-bottom regardless of input order', () => {
    const rows = rebuildRows([glyph('低', 10, 600), glyph('高', 10, 700)]);
    expect(rows).toEqual([['高'], ['低']]);
  });
});

describe('rebuildRows — column splitting', () => {
  it('starts a new cell when the horizontal gap is wide', () => {
    const rows = rebuildRows([glyph('午餐', 10, 700, 40), glyph('28.50', 200, 700, 50)]);
    expect(rows).toEqual([['午餐', '28.50']]);
  });

  it('keeps glyphs in one cell when they sit close together', () => {
    // A single cell can be emitted as several glyph runs by pdf.js.
    const rows = rebuildRows([glyph('示例', 10, 700, 40), glyph('餐厅', 52, 700, 40)]);
    expect(rows).toEqual([['示例餐厅']]);
  });

  it('honours a custom gap threshold', () => {
    const parts = [glyph('示例', 10, 700, 40), glyph('餐厅', 60, 700, 40)];
    expect(rebuildRows(parts, { columnGap: 20 })).toEqual([['示例餐厅']]);
    expect(rebuildRows(parts, { columnGap: 5 })).toEqual([['示例', '餐厅']]);
  });

  it('sorts cells left-to-right regardless of input order', () => {
    const rows = rebuildRows([glyph('28.50', 200, 700, 50), glyph('午餐', 10, 700, 40)]);
    expect(rows).toEqual([['午餐', '28.50']]);
  });
});

describe('rebuildRows — edge cases', () => {
  it('returns nothing for empty input', () => {
    expect(rebuildRows([])).toEqual([]);
  });

  it('ignores empty glyph runs', () => {
    expect(rebuildRows([glyph('', 10, 700)])).toEqual([]);
  });

  it('drops rows that are entirely whitespace', () => {
    const rows = rebuildRows([glyph('   ', 10, 700), glyph('午餐', 10, 680)]);
    expect(rows).toEqual([['午餐']]);
  });

  it('trims cell contents', () => {
    expect(rebuildRows([glyph('  午餐  ', 10, 700)])).toEqual([['午餐']]);
  });

  it('handles a row with a single cell and no width information', () => {
    const rows = rebuildRows([{ text: '只有一列', x: 10, y: 700, width: 0 }]);
    expect(rows).toEqual([['只有一列']]);
  });

  /**
   * The documented failure mode this guards against: naively merging by y can
   * collapse two distinct rows, which is why callers must show the user the
   * rebuilt rows and totals before anything is stored.
   */
  it('keeps two adjacent transactions separate when rows are tight', () => {
    const rows = rebuildRows([
      glyph('2026-09-14', 10, 700, 60),
      glyph('28.50', 200, 700, 40),
      glyph('2026-09-14', 10, 690, 60),
      glyph('19.90', 200, 690, 40),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['2026-09-14', '28.50']);
    expect(rows[1]).toEqual(['2026-09-14', '19.90']);
  });
});

/**
 * The Bank-of-China layout is the reason this module stopped guessing columns
 * from gaps: the generator pads every cell so the columns are flush, and a
 * 12-column transaction reads as one long string. See `fixtures/bocPdf.ts` for
 * the geometry and `AGENTS.md` §8.4 for why PDF is the highest-risk importer.
 */
describe('rebuildRows — columns anchored to the header row', () => {
  const pages = bocFixturePages();
  const header = [
    '记账日期', '记账时间', '币别', '金额', '余额', '交易名称',
    '渠道', '网点名称', '附言', '对方账户名', '对方卡号/账号', '对方开户行',
  ];

  it('derives the column geometry from the header line', () => {
    const spans = inferColumnSpans(pages[0]!);
    expect(spans).toHaveLength(header.length);
    expect(spans![0]!.start).toBe(-Infinity);
    expect(spans![header.length - 1]!.end).toBe(Infinity);
  });

  it('falls back to gap splitting when the page has no header to anchor to', () => {
    const plain = [glyph('午餐', 10, 700, 40), glyph('28.50', 200, 700, 40)];
    expect(inferColumnSpans(plain)).toBeNull();
    expect(rebuildRows(plain)).toEqual([['午餐', '28.50']]);
  });

  it('reads every cell of a padded, flush table', () => {
    const rows = rebuildRows(pages[0]!);
    expect(rows[0]).toEqual(header);
    expect(rows.slice(1)).toEqual([
      [
        '2026-09-10', '22:20:56', '人民币', '111.79', '5,861.13', '网上快捷退款', '银企对接',
        '', '示例商户甲(上海)有限公司', '示例商户甲', 'Z20079A00010N', '',
      ],
      [
        '2026-09-04', '13:22:13', '人民币', '-1,244.00', '5,749.13', '网上快捷支付', '银企对接',
        '', '示例商户乙', '示例商户乙', 'Z20049B00010N', '',
      ],
      [
        '2026-08-05', '08:46:56', '人民币', '-380,000.00', '6,799.54', '银证转账', '其他',
        '', '', '示例证券股份有限公司', '446859B13696', '示例市分行',
      ],
      [
        '2026-08-04', '14:31:06', '人民币', '6,960.00', '181,054.61', '小额普通', '柜台',
        '示例银行示例支行', '柜面提取', '示例公积金管理中心', '1202021C900080988',
        '示例银行股份有限公司示例支行',
      ],
    ]);
  });

  /**
   * A wrapped cell is emitted on a second baseline and carries nothing in the
   * first column. Read as a new row it becomes a one-cell fragment, which both
   * garbles the preview and gives dedupe a different shape than a re-import.
   */
  it('appends a wrapped cell to the row above', () => {
    const rows = rebuildRows(pages[0]!);
    expect(rows).toHaveLength(5);
    // The 附言 was printed as `示例商户甲` plus a wrapped `(上海)有限公司`, and the
    // empty 网点名称 cell's padding was folded into the SAME glyph run.
    expect(rows[1]![8]).toBe('示例商户甲(上海)有限公司');
    expect(rows[1]![7]).toBe('');
  });

  it('treats a cell of nothing but padding dashes as empty', () => {
    const rows = rebuildRows(pages[0]!);
    expect(rows[3]![7]).toBe('');
    expect(rows[3]![8]).toBe('');
  });

  /**
   * The `END` marker sits one row pitch below the last row and has nothing in the
   * first column — exactly like a wrapped cell. Appending it corrupts a real
   * transaction's trailing fields, so the vertical gap has to decide.
   */
  it('does not append the printed END marker to the last row', () => {
    const rows = rebuildRows(pages[0]!);
    expect(rows.flat().some((cell) => cell.includes('END'))).toBe(false);
    expect(rows[4]![11]).toBe('示例银行股份有限公司示例支行');
  });

  it('stops the table at the printed footer note', () => {
    const rows = rebuildRows(pages[0]!);
    expect(rows.flat().some((cell) => cell.includes('温馨提示'))).toBe(false);
    expect(rows.flat().some((cell) => cell.includes('页/共'))).toBe(false);
  });

  it('reuses supplied spans on a page that prints no header', () => {
    const spans = inferColumnSpans(pages[1]!)!;
    const headerless = pages[1]!.filter((item) => item.y < 450);
    const rows = rebuildRows(headerless, { columnSpans: spans });
    expect(rows[0]![0]).toBe('2026-07-23');
    expect(rows[0]![5]).toBe('跨行转账');
  });

  it('keeps the first of the repeated per-page headers', () => {
    const all = pages.flatMap((page) => rebuildRows(page));
    expect(all.filter((row) => row[0] === '记账日期')).toHaveLength(2);

    const deduped = dropRepeatedHeaderRows(all);
    expect(deduped.filter((row) => row[0] === '记账日期')).toHaveLength(1);
    expect(detectHeaderRowIndex(deduped)).toBe(0);
    expect(deduped).toHaveLength(BOC_FIXTURE_ROWS.flat().length + 1);
  });

  /**
   * End to end, against the statement's own printed arithmetic — the same check
   * that caught the real export's column drift. A single value read one column to
   * the left still looks plausible; it does not survive this.
   */
  it('reconciles the rebuilt rows against the totals the statement prints for itself', () => {
    const rows = dropRepeatedHeaderRows(pages.flatMap((page) => rebuildRows(page)));
    const table: Table = { rows, delimiter: '(pdf)', headerRowIndex: detectHeaderRowIndex(rows), notes: [] };
    const result = parseGeneric(table, BOC_DEBIT_PDF_TEMPLATE, { accountId: 'fixture' });

    expect(result.warnings).toEqual([]);
    expect(result.drafts).toHaveLength(BOC_FIXTURE_ROWS.flat().length);

    let inMinor = 0;
    let outMinor = 0;
    for (const draft of result.drafts) {
      if (draft.direction === 'in') inMinor += draft.amountMinor;
      else outMinor += draft.amountMinor;
    }

    const printed = (pageRows: readonly BocRow[]): { debit: number; credit: number } => {
      const totals = bocPrintedTotals(pageRows);
      return {
        debit: Math.round(Number(totals.debit.replace(/,/g, '')) * 100),
        credit: Math.round(Number(totals.credit.replace(/,/g, '')) * 100),
      };
    };
    const debit = BOC_FIXTURE_ROWS.reduce((sum, pageRows) => sum + printed(pageRows).debit, 0);
    const credit = BOC_FIXTURE_ROWS.reduce((sum, pageRows) => sum + printed(pageRows).credit, 0);

    expect(outMinor).toBe(debit);
    expect(inMinor).toBe(credit);
  });

  it('keeps the time of day from the separate time column', () => {
    const rows = dropRepeatedHeaderRows(pages.flatMap((page) => rebuildRows(page)));
    const table: Table = { rows, delimiter: '(pdf)', headerRowIndex: detectHeaderRowIndex(rows), notes: [] };
    const result = parseGeneric(table, BOC_DEBIT_PDF_TEMPLATE, { accountId: 'fixture' });

    // 22:20:56 in Shanghai is 14:20:56 UTC. Reading only the date column would
    // floor this to 2026-09-09T16:00:00.000Z and silently widen both the dedupe
    // window and the ±3 day transfer pairing window.
    expect(result.drafts[0]!.occurredAt).toBe('2026-09-10T14:20:56.000Z');
    expect(result.drafts[0]!.balanceAfterMinor).toBe(586_113);
  });
});
