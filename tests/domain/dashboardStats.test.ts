import { describe, expect, test } from "bun:test";
import { DAY_MS, dayKey, dayNumber, fillDays, offsetMsOf, statsDays, windowStart } from "../../src/domain/dashboardStats.ts";

describe("dashboard stats days", () => {
  test("local days follow the offset", () => {
    const sevenHoursEast = offsetMsOf(-420);
    expect(sevenHoursEast).toBe(7 * 3_600_000);
    // 20:00 UTC on day 10 is already day 11 at UTC+7.
    expect(dayNumber(10 * DAY_MS + 20 * 3_600_000, sevenHoursEast)).toBe(11);
    expect(dayKey(0)).toBe("1970-01-01");
  });

  test("fills the window with zeros and drops rows outside it", () => {
    const now = 5 * DAY_MS + 1;
    const out = fillDays([{ day: 1, n: 9 }, { day: 4, n: 2 }], now, 3, 0, { n: 0 });
    expect(out).toEqual([
      { date: "1970-01-04", n: 0 },
      { date: "1970-01-05", n: 2 },
      { date: "1970-01-06", n: 0 },
    ]);
  });

  test("the window starts at local midnight of its first day", () => {
    const off = offsetMsOf(-420);
    const start = windowStart(10 * DAY_MS, 3, off);
    expect(dayNumber(start, off)).toBe(dayNumber(10 * DAY_MS, off) - 2);
    expect(dayNumber(start - 1, off)).toBe(dayNumber(10 * DAY_MS, off) - 3);
  });

  test("days are clamped", () => {
    expect(statsDays(null)).toBe(30);
    expect(statsDays("7")).toBe(7);
    expect(statsDays("-1")).toBe(30);
    expect(statsDays("x")).toBe(30);
    expect(statsDays("9999")).toBe(365);
  });
});
