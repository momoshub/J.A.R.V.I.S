import { describe, expect, test } from "bun:test";
import { ago, mindfulReport, threadRef, type MindfulView } from "../../src/domain/mindful.ts";

const NOW = 1_000_000;
const base: MindfulView = {
  now: NOW,
  live: [],
  stuck: [],
  workflows: [],
  done: { ok: 0, failed: 0, stopped: 0 },
  spend: {
    runs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    durationMs: 0,
  },
  windowMs: 3_600_000,
};

describe("mindfulReport", () => {
  test("a quiet instance says so instead of printing empty headings", () => {
    expect(mindfulReport(base)).toContain("nothing running, nothing stuck");
  });

  test("what is BROKEN comes before what is busy", () => {
    const out = mindfulReport({
      ...base,
      stuck: [
        {
          channelId: "C1",
          threadTs: "9.9",
          slackUserId: "U1",
          request: "fix the view",
          error: "disk I/O error",
          outcome: "failed",
          endedAt: NOW - 600_000,
        },
      ],
      live: [
        { id: "r1", channelId: "C2", threadTs: "8.8", actor: "U2", what: "summarise", startedAt: NOW - 30_000, state: "running" },
      ],
    });
    expect(out.indexOf("stuck")).toBeLessThan(out.indexOf("running now"));
    expect(out).toContain("10m ago");
    expect(out).toContain("disk I/O error");
    expect(out).toContain("fix the view");
  });

  test("a stopped turn is stuck too, and is not called a failure", () => {
    const out = mindfulReport({
      ...base,
      stuck: [
        { channelId: "C1", threadTs: "9.9", slackUserId: "U1", request: "r", error: "", outcome: "stopped", endedAt: NOW },
      ],
    });
    expect(out).toContain("stopped");
    expect(out).not.toContain("failed:");
  });

  test("what it is waiting on is part of the picture", () => {
    const out = mindfulReport({
      ...base,
      watching: [
        {
          id: 3,
          channelId: "C1",
          threadTs: "9.9",
          check: "gh run view 1 | grep -q completed",
          note: "promote",
          deadlineAt: NOW + 1_800_000,
          attempts: 4,
        },
      ],
    });
    expect(out).toContain("waiting on");
    expect(out).toContain("4 checks");
    expect(out).toContain("gives up in 30m");
    expect(out).not.toContain("nothing running, nothing stuck");
  });

  test("the counts and the spend close it out", () => {
    const out = mindfulReport({
      ...base,
      done: { ok: 7, failed: 2, stopped: 1 },
      spend: { ...base.spend, runs: 10, costUsd: 3.5, inputTokens: 1000, outputTokens: 500 },
    });
    expect(out).toContain("*10 turns* finished: 7 ok, 2 failed, 1 stopped");
    expect(out).toContain("$3.50");
    expect(out).toContain("list price");
  });

  test("a queued turn is marked differently from a running one", () => {
    const out = mindfulReport({
      ...base,
      live: [
        { id: "a", channelId: "C1", actor: "U1", what: "one", startedAt: NOW, state: "running" },
        { id: "b", channelId: "C1", actor: "U2", what: "two", startedAt: NOW, state: "queued" },
      ],
    });
    expect(out).toContain("▶︎");
    expect(out).toContain("⏸");
  });

  test("long requests are clipped, so one line stays one line", () => {
    const out = mindfulReport({
      ...base,
      stuck: [
        { channelId: "C1", threadTs: "9.9", slackUserId: "U1", request: "x".repeat(300), error: "", outcome: "failed", endedAt: NOW },
      ],
    });
    expect(out).toContain("…");
    expect(out.split("\n").every((l) => l.length < 200)).toBe(true);
  });
});

describe("threadRef", () => {
  test("a real link when the workspace is known", () => {
    expect(threadRef("C1", "1793700990.971739", "acme-talk")).toContain(
      "acme-talk.slack.com/archives/C1/p1793700990971739",
    );
  });

  test("and something still clickable when it is not", () => {
    expect(threadRef("C1", "1.2")).toContain("<#C1>");
    expect(threadRef("C1", "")).toBe("<#C1>");
  });
});

describe("ago", () => {
  test("reads the way someone would say it", () => {
    expect(ago(5_000)).toBe("5s");
    expect(ago(90_000)).toBe("2m");
    expect(ago(3_900_000)).toBe("1h05m");
    expect(ago(-5)).toBe("0s");
  });
});
