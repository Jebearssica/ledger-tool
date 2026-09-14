import { describe, expect, it } from 'vitest';
import { joinText, rebuildRows, type PositionedTextItem } from './pdf';

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
