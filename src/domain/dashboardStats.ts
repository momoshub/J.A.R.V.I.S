/**
 * Day series for the overview charts.
 *
 * SQL only returns the days that had something in them, and a chart drawn from
 * that skips the quiet days entirely - a week of nothing looks like a busy
 * stretch. So every series is laid over the full window, zeros included.
 */
export const DAY_MS = 86_400_000;

/** The local-time offset to bucket by, from `Date#getTimezoneOffset` minutes (west is positive). */
export const offsetMsOf = (timezoneOffsetMinutes: number): number => -timezoneOffsetMinutes * 60_000;

/** The day number of `ms` under `offsetMs` - the same formula the stats SQL uses. */
export const dayNumber = (ms: number, offsetMs: number): number => Math.floor((ms + offsetMs) / DAY_MS);

/** `YYYY-MM-DD` of a day number (already in local time, so read it as UTC). */
export const dayKey = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * `days` consecutive days ending on the one holding `now`, each with the row
 * for that day or `zero`. Rows outside the window are dropped.
 */
export const fillDays = <T extends { readonly day: number }>(
  rows: readonly T[],
  now: number,
  days: number,
  offsetMs: number,
  zero: Omit<T, "day">,
): (Omit<T, "day"> & { readonly date: string })[] => {
  const last = dayNumber(now, offsetMs);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: Math.max(0, days) }, (_, i) => {
    const d = last - (days - 1) + i;
    const { day: _day, ...rest } = byDay.get(d) ?? ({ day: d, ...zero } as T);
    return { ...(rest as Omit<T, "day">), date: dayKey(d) };
  });
};

/** The first instant of the window `fillDays` draws, for the SQL `since`. */
export const windowStart = (now: number, days: number, offsetMs: number): number =>
  (dayNumber(now, offsetMs) - (Math.max(1, days) - 1)) * DAY_MS - offsetMs;

/** Days to chart, clamped: anything unreadable means 30, never more than a year. */
export const statsDays = (v: string | null): number => {
  const n = Math.floor(Number(v ?? "30"));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 30;
};
