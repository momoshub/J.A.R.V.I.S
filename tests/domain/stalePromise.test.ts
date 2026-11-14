import { describe, expect, test } from "bun:test";
import {
  eligible,
  looksLikePromise,
  humanSince,
  parseNudged,
  parsePromiseVerdict,
  pruneNudged,
  type ThreadFacts,
} from "../../src/domain/stalePromise.ts";

describe("looksLikePromise", () => {
  test.each([
    "Done with the draft. Next I will update the post with the new numbers.",
    "The tests pass. I'll push the fix and open the PR.",
    "Once that merges, I'll update the docs.",
    "Next step is to rewrite the intro.",
    "Việc tiếp theo là sửa bài viết cho khớp với số liệu mới.",
    "Em đã check xong phần 1. Xong em gửi báo cáo cho anh.",
    "Bước tiếp theo em sẽ cập nhật lại bài.",
    "Em sẽ sửa lại phần đó.",
    "Để em làm tiếp phần còn lại.",
  ])("promise: %s", (text) => expect(looksLikePromise(text)).toBe(true));

  test.each([
    "The deploy finished and all checks are green.",
    "Here is the summary of what changed: two files, one new test.",
    "Do you want me to update the post next?",
    "If you want, I'll update the post. Let me know.",
    "I updated the post and sent the report.",
    "Next I will update the post, ok?",
    "Em đã sửa xong bài, anh xem giúp em nhé.",
    "Anh muốn em gửi báo cáo luôn không?",
    "Để em làm nhé?",
    "",
  ])("not a promise: %s", (text) => expect(looksLikePromise(text)).toBe(false));

  test("ignores mentions and code blocks", () => {
    expect(looksLikePromise("```\nI will fix it\n```\nThat is the log.")).toBe(false);
    expect(looksLikePromise("<@U123> next I will update the post.")).toBe(true);
  });
});

describe("parsePromiseVerdict", () => {
  test("only a plain YES counts; anything unreadable is no", () => {
    expect(parsePromiseVerdict("YES")).toBe(true);
    expect(parsePromiseVerdict(" yes.\n")).toBe(true);
    expect(parsePromiseVerdict("NO")).toBe(false);
    expect(parsePromiseVerdict("Not sure")).toBe(false);
    expect(parsePromiseVerdict("")).toBe(false);
  });
});

const NOW = 1_800_000_000_000;
const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  lastIsOwn: true,
  lastTs: String((NOW - 45 * 60_000) / 1000),
  now: NOW,
  minAgeMs: 30 * 60_000,
  turnRunning: false,
  workflowActive: false,
  watches: 0,
  reminders: 0,
  liveWorker: false,
  ...over,
});

describe("eligible", () => {
  test("a quiet old bot message is eligible", () => expect(eligible(facts()).ok).toBe(true));

  test.each([
    ["human spoke last", { lastIsOwn: false }],
    ["too recent", { lastTs: String((NOW - 10 * 60_000) / 1000) }],
    ["a turn is running", { turnRunning: true }],
    ["workflow thread", { workflowActive: true }],
    ["a watch is waiting", { watches: 1 }],
    ["a reminder is waiting", { reminders: 2 }],
    ["a worker is live", { liveWorker: true }],
    ["already nudged", { nudgedTs: String((NOW - 45 * 60_000) / 1000) }],
    ["unreadable ts", { lastTs: "nope" }],
  ] as const)("excluded: %s", (_name, over) => expect(eligible(facts(over)).ok).toBe(false));

  test("a newer bot message is not covered by an older nudge", () =>
    expect(eligible(facts({ nudgedTs: "1.1" })).ok).toBe(true));
});

describe("nudged record", () => {
  test("round-trips, ignores junk and prunes old entries", () => {
    const map = { "C1:1.1": { ts: "2.2", at: NOW }, "C1:old": { ts: "1.1", at: NOW - 3 * 24 * 60 * 60_000 } };
    expect(parseNudged(JSON.stringify(map))).toEqual(map);
    expect(parseNudged("not json")).toEqual({});
    expect(parseNudged(JSON.stringify({ a: { ts: 1 } }))).toEqual({});
    expect(Object.keys(pruneNudged(map, NOW))).toEqual(["C1:1.1"]);
  });
});

describe("per-thread bound", () => {
  test("a record keeps its seen and rejected marks", () => {
    const map = { "C1:1.1": { ts: "5.1", at: 9, seen: 10, rejected: "6.1" } };
    expect(parseNudged(JSON.stringify(map))).toEqual(map);
  });
  test("a thread is nudged again only after a person spoke since the last nudge", () => {
    const r = [
      { ts: "5.1", own: true },
      { ts: "6.1", own: true },
    ];
    expect(humanSince(r, "")).toBe(true);
    expect(humanSince(r, "5.1")).toBe(false);
    expect(humanSince([...r, { ts: "7.1", own: false }], "5.1")).toBe(true);
    expect(humanSince([{ ts: "4.1", own: false }, ...r], "5.1")).toBe(false);
  });
});
