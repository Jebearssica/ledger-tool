import { describe, expect, it } from 'vitest';
import {
  bucketEpochSeconds,
  combineDateAndTime,
  formatShanghai,
  parseWallClock,
  shanghaiDayStart,
  shanghaiMonth,
  toUtcIso,
} from '../domain/dates';

describe('parseWallClock', () => {
  it('reads the shapes Chinese statements actually use', () => {
    expect(parseWallClock('2026-09-14 10:30:00')).toEqual({ y: 2026, mo: 9, d: 14, hh: 10, mi: 30, ss: 0 });
    expect(parseWallClock('2026/9/14 10:30')).toEqual({ y: 2026, mo: 9, d: 14, hh: 10, mi: 30, ss: 0 });
    expect(parseWallClock('2026年9月14日 10:30')).toEqual({ y: 2026, mo: 9, d: 14, hh: 10, mi: 30, ss: 0 });
    expect(parseWallClock('2026-09-14')).toEqual({ y: 2026, mo: 9, d: 14, hh: 0, mi: 0, ss: 0 });
  });

  it('reads compact digit-only timestamps', () => {
    expect(parseWallClock('20260914103000')).toEqual({ y: 2026, mo: 9, d: 14, hh: 10, mi: 30, ss: 0 });
    expect(parseWallClock('20260914')).toEqual({ y: 2026, mo: 9, d: 14, hh: 0, mi: 0, ss: 0 });
  });

  it('rejects out-of-range and unusable values', () => {
    expect(parseWallClock('')).toBeNull();
    expect(parseWallClock('abc')).toBeNull();
    expect(parseWallClock('2026-13-01')).toBeNull();
    expect(parseWallClock('2026-09-32')).toBeNull();
    expect(parseWallClock('2026-09-14 25:00')).toBeNull();
    expect(parseWallClock('1800-01-01')).toBeNull();
  });
});

describe('combineDateAndTime', () => {
  it('joins a separate date and time column', () => {
    // Bank statements split these; reading only the date floors every row in the
    // file to midnight, which quietly widens the dedupe and transfer windows.
    expect(toUtcIso(combineDateAndTime('2026-09-10', '22:20:56'))).toBe('2026-09-10T14:20:56.000Z');
    expect(toUtcIso(combineDateAndTime('2026-09-10', '22:20'))).toBe('2026-09-10T14:20:00.000Z');
  });

  it('leaves a date alone when there is no time column', () => {
    expect(combineDateAndTime('2026-09-10', '')).toBe('2026-09-10');
    expect(combineDateAndTime('2026-09-10', undefined)).toBe('2026-09-10');
  });

  it('prefers a timestamp already inside the date column', () => {
    // Appending would produce `2026-09-10 10:00:00 22:20:56`, whose extra numbers
    // are dropped by the parser — silently keeping the wrong time.
    expect(combineDateAndTime('2026-09-10 10:00:00', '22:20:56')).toBe('2026-09-10 10:00:00');
  });
});

describe('toUtcIso', () => {
  it('converts Shanghai wall-clock time to UTC', () => {    // 10:30 in Shanghai (UTC+8) is 02:30 UTC.
    expect(toUtcIso('2026-09-14 10:30:00')).toBe('2026-09-14T02:30:00.000Z');
    expect(toUtcIso('2026-09-14 00:30:00')).toBe('2026-09-13T16:30:00.000Z');
  });

  it('treats a date with no time as midnight Shanghai', () => {
    expect(toUtcIso('2026-09-14')).toBe('2026-09-13T16:00:00.000Z');
  });

  it('refuses impossible dates instead of rolling them over', () => {
    // new Date('2026-02-31') would silently become March 3rd.
    expect(toUtcIso('2026-02-31')).toBeNull();
    expect(toUtcIso('2026-04-31')).toBeNull();
    expect(toUtcIso('not a date')).toBeNull();
  });

  it('accepts an already-absolute instant unchanged', () => {
    expect(toUtcIso('2026-09-14T02:30:00.000Z')).toBe('2026-09-14T02:30:00.000Z');
    expect(toUtcIso('2026-09-14T10:30:00+08:00')).toBe('2026-09-14T02:30:00.000Z');
  });
});

describe('bucketEpochSeconds', () => {
  it('collapses times inside the same window', () => {
    const a = toUtcIso('2026-09-14 10:00:30')!;
    const b = toUtcIso('2026-09-14 10:01:59')!;
    expect(bucketEpochSeconds(a, 2)).toBe(bucketEpochSeconds(b, 2));
  });

  it('separates times in different windows', () => {
    const a = toUtcIso('2026-09-14 10:00:30')!;
    const b = toUtcIso('2026-09-14 10:20:30')!;
    expect(bucketEpochSeconds(a, 2)).not.toBe(bucketEpochSeconds(b, 2));
  });
});

describe('Shanghai rendering', () => {
  it('formats a stored UTC instant in local time', () => {
    expect(formatShanghai('2026-09-14T02:30:00.000Z')).toBe('2026-09-14 10:30');
  });

  it('derives the local day and month, not the UTC ones', () => {
    // 16:00 UTC on the 13th is midnight on the 14th in Shanghai, so the local
    // day must be the 14th.
    expect(shanghaiDayStart('2026-09-13T16:00:00.000Z')).toBe('2026-09-13T16:00:00.000Z');
    expect(shanghaiMonth('2026-09-13T16:00:00.000Z')).toBe('2026-09');
    expect(shanghaiMonth('2026-08-31T16:00:00.000Z')).toBe('2026-09');
  });
});
