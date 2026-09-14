/**
 * Date/time handling. See AGENTS.md §4.
 *
 * Storage is UTC ISO-8601; rendering is `Asia/Shanghai`. Statements print local
 * wall-clock times, so parsing must convert — not just reinterpret — them.
 */

/**
 * China has had no DST since 1991, so a fixed offset is correct rather than a
 * simplification. Everything here depends on that.
 */
export const SHANGHAI_OFFSET_MINUTES = 8 * 60;

export interface WallClock {
  y: number;
  mo: number;
  d: number;
  hh: number;
  mi: number;
  ss: number;
}

/**
 * Pull a calendar date (and optional time) out of the many shapes statements use:
 *
 *   "2026-09-14 10:30:00"   "2026/9/14 10:30"   "2026年9月14日 10:30"
 *   "20260914103000"        "2026-09-14"
 *
 * @returns the wall-clock fields, or `null` if the text is not a usable date.
 */
export function parseWallClock(text: string): WallClock | null {
  if (!text) return null;
  const s = String(text).normalize('NFKC').trim();
  if (s === '') return null;

  let y: number;
  let mo: number;
  let d: number;
  let hh = 0;
  let mi = 0;
  let ss = 0;

  const digitsOnly = s.replace(/\D/g, '');
  const hasSeparator = /[-/年月]/.test(s);
  const compact = !hasSeparator && (digitsOnly.length === 8 || digitsOnly.length === 12 || digitsOnly.length === 14);

  if (compact) {
    y = Number(digitsOnly.slice(0, 4));
    mo = Number(digitsOnly.slice(4, 6));
    d = Number(digitsOnly.slice(6, 8));
    if (digitsOnly.length >= 12) {
      hh = Number(digitsOnly.slice(8, 10));
      mi = Number(digitsOnly.slice(10, 12));
    }
    if (digitsOnly.length === 14) ss = Number(digitsOnly.slice(12, 14));
  } else {
    const nums = s.match(/\d+/g);
    if (!nums || nums.length < 3) return null;
    y = Number(nums[0]);
    mo = Number(nums[1]);
    d = Number(nums[2]);
    if (nums.length >= 5) {
      hh = Number(nums[3]);
      mi = Number(nums[4]);
    }
    if (nums.length >= 6) ss = Number(nums[5]);
  }

  if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  if (hh < 0 || hh > 23 || mi < 0 || mi > 59 || ss < 0 || ss > 59) return null;

  return { y, mo, d, hh, mi, ss };
}

/**
 * Convert a statement timestamp to UTC ISO-8601.
 *
 * Unlike a naive `new Date(text)`, this rejects impossible dates such as
 * 2026-02-31 rather than silently rolling them into March.
 */
export function toUtcIso(
  text: string,
  offsetMinutes: number = SHANGHAI_OFFSET_MINUTES,
): string | null {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (s === '') return null;

  // Already an absolute instant — trust the embedded offset.
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  const wc = parseWallClock(s);
  if (!wc) return null;

  // Reject rollover: Date.UTC happily turns Feb 31 into Mar 3.
  const asUtc = new Date(Date.UTC(wc.y, wc.mo - 1, wc.d));
  if (asUtc.getUTCMonth() !== wc.mo - 1 || asUtc.getUTCDate() !== wc.d) return null;

  const ms = Date.UTC(wc.y, wc.mo - 1, wc.d, wc.hh, wc.mi, wc.ss) - offsetMinutes * 60_000;
  return new Date(ms).toISOString();
}

export function epochSeconds(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * Floor an instant to a fixed window, so two statements that disagree by a
 * minute or two still produce the same key. See AGENTS.md §5.
 */
export function bucketEpochSeconds(iso: string, windowMinutes: number): number {
  const windowSeconds = Math.max(1, windowMinutes) * 60;
  return Math.floor(epochSeconds(iso) / windowSeconds) * windowSeconds;
}

const shanghaiFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Render a stored UTC instant as Shanghai local time, e.g. `2026-09-14 10:30`. */
export function formatShanghai(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return shanghaiFormatter.format(new Date(t));
}

/** Midnight (Shanghai) of the day containing `iso`, as a UTC ISO string. */
export function shanghaiDayStart(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const local = new Date(t + SHANGHAI_OFFSET_MINUTES * 60_000);
  const ms =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    SHANGHAI_OFFSET_MINUTES * 60_000;
  return new Date(ms).toISOString();
}

/** `YYYY-MM` in Shanghai local time — used as the period bucket for reports. */
export function shanghaiMonth(iso: string): string {
  return formatShanghai(iso).slice(0, 7);
}
