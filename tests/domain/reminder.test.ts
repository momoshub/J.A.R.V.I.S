import { describe, expect, test } from "bun:test";
import {
  formatWhen,
  humanLead,
  parseClock,
  parseRemindArgs,
  parseSpan,
  reminderMessage,
} from "../../src/domain/reminder.ts";

// Thu 05/11/2026 17:30 at +07:00.
const OFFSET = 7 * 60;
const NOW = Date.UTC(2026, 10, 5, 10, 30);
const ME = "U1";

const at = (y: number, mo: number, d: number, h: number, m = 0) => Date.UTC(y, mo - 1, d, h, m) - OFFSET * 60_000;
const parse = (s: string) => parseRemindArgs(s, ME, NOW, OFFSET);

describe("parseSpan", () => {
  test("reads units and combinations", () => {
    expect(parseSpan("90s")).toBe(90_000);
    expect(parseSpan("2h")).toBe(7_200_000);
    expect(parseSpan("1h30m")).toBe(5_400_000);
    expect(parseSpan("3d")).toBe(3 * 86_400_000);
    expect(parseSpan("20")).toBe(20 * 60_000);
  });
  test("refuses what is not a span", () => {
    expect(parseSpan("3pm")).toBeUndefined();
    expect(parseSpan("check")).toBeUndefined();
    expect(parseSpan("2hx")).toBeUndefined();
  });
});

describe("parseClock", () => {
  test("24h, am/pm and the h form", () => {
    expect(parseClock("15:00")).toBe(15 * 60);
    expect(parseClock("3pm")).toBe(15 * 60);
    expect(parseClock("3:30pm")).toBe(15 * 60 + 30);
    expect(parseClock("12am")).toBe(0);
    expect(parseClock("12pm")).toBe(12 * 60);
    expect(parseClock("15h30")).toBe(15 * 60 + 30);
  });
  test("refuses an impossible time", () => {
    expect(parseClock("25:00")).toBeUndefined();
    expect(parseClock("13pm")).toBeUndefined();
  });
});

describe("parseRemindArgs", () => {
  test("in <span>, for whoever asked", () => {
    const r = parse("me in 2h to check the deploy");
    expect(r).toEqual({ ok: true, targets: [ME], dueAt: NOW + 7_200_000, text: "check the deploy" });
  });

  test("a bare span works too", () => {
    const r = parse("20m stand up");
    expect(r.ok && r.dueAt).toBe(NOW + 20 * 60_000);
  });

  test("a time later today is today", () => {
    const r = parse("at 18:00 call the bank");
    expect(r.ok && r.dueAt).toBe(at(2026, 11, 5, 18));
  });

  test("a time already gone today is tomorrow", () => {
    const r = parse("at 9am standup notes");
    expect(r.ok && r.dueAt).toBe(at(2026, 11, 6, 9));
  });

  test("tomorrow with no hour is nine", () => {
    const r = parse("tomorrow review the PR");
    expect(r.ok && r.dueAt).toBe(at(2026, 11, 6, 9));
  });

  test("tomorrow and a time, in either order", () => {
    expect(parse("tomorrow 3pm x").ok && (parse("tomorrow 3pm x") as { dueAt: number }).dueAt).toBe(at(2026, 11, 6, 15));
    expect((parse("at 15h tomorrow x") as { dueAt: number }).dueAt).toBe(at(2026, 11, 6, 15));
  });

  test("a date, with and without a time", () => {
    expect((parse("on 2026-12-01 at 10:00 renew") as { dueAt: number }).dueAt).toBe(at(2026, 12, 1, 10));
    expect((parse("1/12 renew") as { dueAt: number }).dueAt).toBe(at(2026, 12, 1, 9));
  });

  test("a day and month already gone means next year", () => {
    expect((parse("5/1 taxes") as { dueAt: number }).dueAt).toBe(at(2027, 1, 5, 9));
  });

  test("tags other people, once each", () => {
    const r = parse("<@U2> <@U3|bob> <@U2> in 1h ship it");
    expect(r.ok && r.targets).toEqual(["U2", "U3"]);
  });

  test("the text is kept verbatim after the time", () => {
    const r = parse("in 1h check 5h worth of logs at 3pm");
    expect(r.ok && r.text).toBe("check 5h worth of logs at 3pm");
  });

  test("refuses no time, no text, the past and the far future", () => {
    expect(parse("check the deploy")).toMatchObject({ ok: false });
    expect(parse("in 2h")).toMatchObject({ ok: false, error: "say what to remind about" });
    expect(parse("on 2025-01-01 old")).toMatchObject({ ok: false });
    expect(parse("in 100d far")).toMatchObject({ ok: false });
  });
});

describe("formatting", () => {
  test("formatWhen reads in the given offset", () => {
    expect(formatWhen(at(2026, 11, 6, 9), OFFSET)).toBe("Fri 06/11 09:00");
  });
  test("humanLead", () => {
    expect(humanLead(5 * 60_000)).toBe("in 5m");
    expect(humanLead(125 * 60_000)).toBe("in 2h05m");
    expect(humanLead(5 * 86_400_000)).toBe("in 5d");
  });
  test("reminderMessage names the setter only when it is somebody else", () => {
    expect(reminderMessage([ME], "x", ME)).toBe(`⏰ <@${ME}> reminder: x`);
    expect(reminderMessage(["U2"], "x", ME)).toBe(`⏰ <@U2> reminder: x (from <@${ME}>)`);
  });
});
