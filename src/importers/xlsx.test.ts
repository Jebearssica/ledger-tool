import { afterEach, describe, expect, it } from 'vitest';
import { excelWallClock } from './xlsx';
import { toUtcIso } from '../domain/dates';

/**
 * `read-excel-file` converts an Excel date serial into `Date.UTC(<printed wall
 * clock>)`, i.e. the instant it hands back is the stamped local time *re-read as
 * UTC* (its README shows `1995-01-01` arriving as `1995-01-01T00:00:00.000Z`).
 *
 * Reading the local fields, as this module used to, therefore added the machine's
 * UTC offset on top of every timestamp. On a UTC+8 machine a real
 * `2026-08-30 22:27:32` WeChat row came back as `2026-08-31 06:27:32`, silently
 * moving late-evening spending into the next day — and so into the wrong day
 * bucket, month total and dedupe window.
 *
 * The timezone is forced below because under `TZ=UTC` — which is what CI runs —
 * the local and the UTC fields coincide and the bug is invisible.
 */
const originalTimezone = process.env.TZ;

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe('excelWallClock', () => {
  it('renders the wall clock the spreadsheet shows, not the machine offset', () => {
    process.env.TZ = 'Asia/Shanghai';

    // Guards the guard: if the runtime ignored the change, this test would stop
    // covering anything at all, so prove the offset really is +08:00 first.
    expect(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()).toBe(-480);

    // A real WeChat export printed 2026-08-30 22:27:32 for this instant; reading
    // the local fields produced 2026-08-31 06:27:32 instead.
    expect(excelWallClock(new Date(Date.UTC(2026, 7, 30, 22, 27, 32)))).toBe('2026-08-30 22:27:32');
  });

  it('survives the trip into UTC and back', () => {
    // The point of the wall clock is that `toUtcIso` can then read it as
    // Asia/Shanghai (AGENTS.md §4), which is what the export states its times are.
    expect(toUtcIso(excelWallClock(new Date(Date.UTC(2026, 7, 30, 22, 27, 32))))).toBe(
      '2026-08-30T14:27:32.000Z',
    );
  });

  it('drops the time when the cell is a bare date', () => {
    expect(excelWallClock(new Date(Date.UTC(2026, 8, 1)))).toBe('2026-09-01');
  });

  it('pads every field to two digits', () => {
    expect(excelWallClock(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('2026-01-02 03:04:05');
  });
});
