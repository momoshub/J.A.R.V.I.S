import { describe, expect, test } from "bun:test";
import {
  MIN_INTERVAL_MS,
  MIN_SCRIPT_INTERVAL_MS,
  loopTurnText,
  nextRun,
  parseLoopArgs,
  parseSchedule,
  scheduleText,
} from "../../src/domain/loop.ts";

// Thu 05/11/2026 17:30 at +07:00.
const OFFSET = 7 * 60;
const NOW = Date.UTC(2026, 10, 5, 10, 30);
const at = (y: number, mo: number, d: number, h: number, m = 0) => Date.UTC(y, mo - 1, d, h, m) - OFFSET * 60_000;

const ok = (s: string) => {
  const p = parseLoopArgs(s);
  if (!p.ok) throw new Error(p.error);
  return p;
};

describe("parseLoopArgs: prompt mode", () => {
  test("every monday 9am", () => {
    const p = ok("every monday 9am search the web for new slang");
    expect(p.schedule).toEqual({ kind: "weekly", weekday: 1, minutes: 9 * 60 });
    expect(p.prompt).toBe("search the web for new slang");
    expect(p.command).toBe("");
  });
  test("a weekday with no hour is 09:00, and short names work", () => {
    expect(ok("every fri update it").schedule).toEqual({ kind: "weekly", weekday: 5, minutes: 540 });
    expect(ok("every mondays at 7:30am go").schedule).toEqual({ kind: "weekly", weekday: 1, minutes: 450 });
  });
  test("every day at 18:00", () => {
    const p = ok("every day at 18:00 summarise the day");
    expect(p.schedule).toEqual({ kind: "daily", minutes: 18 * 60 });
    expect(p.prompt).toBe("summarise the day");
  });
  test("every day with no clock is a 24h interval and the prompt keeps its words", () => {
    const p = ok("every day 18 things to check");
    expect(p.schedule).toEqual({ kind: "interval", everyMs: 86_400_000 });
    expect(p.prompt).toBe("18 things to check");
  });
  test("every 6h and every week", () => {
    expect(ok("every 6h check").schedule).toEqual({ kind: "interval", everyMs: 6 * 3_600_000 });
    expect(ok("every week check").schedule).toEqual({ kind: "interval", everyMs: 7 * 86_400_000 });
  });
  test("refuses under an hour, a bare number, no prompt and no schedule", () => {
    expect(parseLoopArgs("every 30m check")).toEqual({ ok: false, error: "the shortest loop is every 1h" });
    expect(parseLoopArgs("every 6 check").ok).toBe(false);
    expect(parseLoopArgs("every monday 9am").ok).toBe(false);
    expect(parseLoopArgs("monday check").ok).toBe(false);
    expect(parseLoopArgs("every blue moon check").ok).toBe(false);
    expect(MIN_INTERVAL_MS).toBe(3_600_000);
  });
});

describe("parseLoopArgs: script mode", () => {
  test("reads `-- <shell>` verbatim", () => {
    const p = ok("every 15m -- curl -s 'https://x.test/a  b' | jq .ok");
    expect(p.schedule).toEqual({ kind: "interval", everyMs: 900_000 });
    expect(p.command).toBe("curl -s 'https://x.test/a  b' | jq .ok");
    expect(p.prompt).toBe("");
  });
  test("works after a clock schedule", () => {
    const p = ok("every monday 9am -- ./sync.sh --all");
    expect(p.schedule).toEqual({ kind: "weekly", weekday: 1, minutes: 540 });
    expect(p.command).toBe("./sync.sh --all");
  });
  test("minimum is 5m, not 1h", () => {
    expect(ok("every 5m -- true").command).toBe("true");
    expect(parseLoopArgs("every 4m -- true")).toEqual({ ok: false, error: "the shortest script loop is every 5m" });
    expect(MIN_SCRIPT_INTERVAL_MS).toBe(300_000);
  });
  test("needs a command after --", () => {
    expect(parseLoopArgs("every 1h --").ok).toBe(false);
  });
});

describe("nextRun", () => {
  test("interval counts from now", () => {
    expect(nextRun({ kind: "interval", everyMs: 3_600_000 }, NOW, OFFSET)).toBe(NOW + 3_600_000);
  });
  test("daily: later today, else tomorrow", () => {
    expect(nextRun({ kind: "daily", minutes: 18 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 5, 18));
    expect(nextRun({ kind: "daily", minutes: 9 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 6, 9));
  });
  test("exactly on the slot moves to the next one", () => {
    expect(nextRun({ kind: "daily", minutes: 17 * 60 + 30 }, NOW, OFFSET)).toBe(at(2026, 11, 6, 17, 30));
  });
  test("weekly: next monday, and a same-day slot already passed waits a week", () => {
    expect(nextRun({ kind: "weekly", weekday: 1, minutes: 540 }, NOW, OFFSET)).toBe(at(2026, 11, 9, 9));
    expect(nextRun({ kind: "weekly", weekday: 4, minutes: 18 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 5, 18));
    expect(nextRun({ kind: "weekly", weekday: 4, minutes: 9 * 60 }, NOW, OFFSET)).toBe(at(2026, 11, 12, 9));
  });
});

describe("schedule text", () => {
  test("round-trips through parseSchedule", () => {
    for (const line of ["every monday 9am x", "every day at 18:00 x", "every 6h x", "every week x", "every 90m x"]) {
      const s = ok(line).schedule;
      expect(parseSchedule(scheduleText(s))).toEqual(s);
    }
    expect(scheduleText({ kind: "weekly", weekday: 1, minutes: 540 })).toBe("every monday at 09:00");
  });
  test("a stored 5m script schedule is still readable", () => {
    expect(parseSchedule("every 5m")).toEqual({ kind: "interval", everyMs: 300_000 });
  });
});

describe("loopTurnText", () => {
  test("is prefixed so the turn knows it is scheduled", () => {
    const t = loopTurnText(7, "every day at 18:00", "do it");
    expect(t.startsWith("[loop 7] ")).toBe(true);
    expect(t).toContain("short");
    expect(t.endsWith("do it")).toBe(true);
  });
});
