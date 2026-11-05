import { describe, expect, test } from "bun:test";
import {
  busyNotice,
  forHowLong,
  nameOfRequest,
  stoppedNotice,
  stillStoppingNotice,
} from "../../src/domain/runControl.ts";

describe("forHowLong", () => {
  test("reads at a glance rather than needing decoding", () => {
    expect(forHowLong(4_000)).toBe("4s");
    expect(forHowLong(90_000)).toBe("2m");
    expect(forHowLong(45 * 60_000)).toBe("45m");
    expect(forHowLong(90 * 60_000)).toBe("1.5h");
    expect(forHowLong(-5)).toBe("0s");
  });
});

describe("nameOfRequest", () => {
  test("a label, not a quote", () => {
    expect(nameOfRequest("<@U0BOT000001|Jarvis> give me the escalation plans")).toBe(
      "give me the escalation plans",
    );
    expect(nameOfRequest("one\n  two   three")).toBe("one two three");
  });

  test("long asks are clipped, empty ones still name something", () => {
    expect(nameOfRequest("x".repeat(80))).toHaveLength(48);
    expect(nameOfRequest("x".repeat(80)).endsWith("…")).toBe(true);
    expect(nameOfRequest("<@U1>")).toBe("that one");
    expect(nameOfRequest("   ")).toBe("that one");
  });
});

describe("the notices", () => {
  test("busy names what is in the way, not just that something is", () => {
    // "still on the one before this" does not say which one, and in a thread
    // with several asks in flight that is the only useful part
    const text = busyNotice({ what: "the escalation plans", startedAt: 0 }, 120_000);
    expect(text).toContain("the escalation plans");
    expect(text).toContain("2m so far");
    expect(text).toContain("yours is next");
  });

  test("stopped says what went, and by whom when it was not their own", () => {
    const run = { what: "the big review", startedAt: 0, actor: "U1" };
    expect(stoppedNotice(run, "U1", 60_000)).toBe("⏹ stopped *the big review* after 1m");
    expect(stoppedNotice(run, "U2", 60_000)).toBe("⏹ stopped *the big review* by <@U2> after 1m");
  });
});

describe("stillStoppingNotice", () => {
  test("it does not pretend a second press did anything", () => {
    const text = stillStoppingNotice({ what: "a long job", stoppedAt: 1000 }, 61_000);
    expect(text).toContain("already stopping");
    expect(text).toContain("1m ago");
    expect(text).toContain("has not let go");
  });

  test("it still reads sensibly when the stop time is unknown", () => {
    expect(stillStoppingNotice({ what: "a job" }, 0)).toContain("already stopping");
  });
});
