import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EVERY_MS,
  gaveUpMessage,
  humanDuration,
  MAX_DEADLINE_MS,
  MIN_EVERY_MS,
  parseDuration,
  parseWatchArgs,
  readyMessage,
} from "../../src/domain/watch.ts";

describe("parseDuration", () => {
  test("the shapes people type", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("5")).toBe(300_000); // a bare number is minutes
    expect(parseDuration("90 sec")).toBe(90_000);
  });

  test("nonsense is nonsense", () => {
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("0m")).toBeUndefined();
    expect(parseDuration("-5m")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });
});

describe("parseWatchArgs", () => {
  test("the real case: poll a build, then promote", () => {
    const a = parseWatchArgs(
      "--every 1m --until 45m promote be US then SG -- gh run view 123 --json status -q .status | grep -q completed",
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.everyMs).toBe(60_000);
    expect(a.deadlineMs).toBe(45 * 60_000);
    expect(a.note).toBe("promote be US then SG");
    // the predicate survives its pipes and flags intact
    expect(a.check).toBe("gh run view 123 --json status -q .status | grep -q completed");
  });

  test("no predicate is a plain timer, which is still useful", () => {
    const a = parseWatchArgs("--until 10m check the build again");
    expect(a.ok && a.check).toBe("");
    expect(a.ok && a.note).toBe("check the build again");
  });

  test("defaults are sane when nothing is said", () => {
    const a = parseWatchArgs("promote it");
    expect(a.ok && a.everyMs).toBe(DEFAULT_EVERY_MS);
  });

  test("it refuses to spin", () => {
    const a = parseWatchArgs("--every 1s do it");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("fastest");
  });

  test("it refuses to wait forever", () => {
    const a = parseWatchArgs("--until 48h do it");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("at most");
  });

  test("checking once after giving up is caught", () => {
    const a = parseWatchArgs("--every 30m --until 5m do it");
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toContain("already given up");
  });

  test("a watch with nothing to do afterwards is pointless", () => {
    expect(parseWatchArgs("--every 1m").ok).toBe(false);
    expect(parseWatchArgs("-- gh run view 1").ok).toBe(false);
  });

  test("a dangling separator is refused rather than silently dropped", () => {
    expect(parseWatchArgs("do the thing --").ok).toBe(false);
  });

  test("a bad duration is named, not ignored", () => {
    const a = parseWatchArgs("--every soon do it");
    expect(!a.ok && a.error).toContain("--every");
  });
});

describe("the messages a watch sends back", () => {
  test("ready tells it to carry on, not to start over", () => {
    const m = readyMessage("promote be US then SG", 600_000, "status\ncompleted");
    expect(m).toContain("do not start it over");
    expect(m).toContain("promote be US then SG");
    expect(m).toContain("10m");
    expect(m).toContain("completed");
  });

  test("giving up is explicit that nothing was done", () => {
    const m = gaveUpMessage("promote it", 2_700_000, "the build never finished");
    expect(m).toContain("I have not done it");
    expect(m).toContain("45m");
  });
});

describe("humanDuration", () => {
  test("round trips the way it reads", () => {
    expect(humanDuration(MIN_EVERY_MS)).toBe("15s");
    expect(humanDuration(600_000)).toBe("10m");
    expect(humanDuration(MAX_DEADLINE_MS)).toBe("6h00m");
  });
});
