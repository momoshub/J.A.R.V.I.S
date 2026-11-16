import { describe, expect, test } from "bun:test";
import {
  applySelfPostCall,
  blocksText,
  isDuplicateReply,
  normalizeText,
  repeatsPosted,
  type SelfPost,
} from "../../src/domain/selfPost.ts";

const post = (...texts: string[]): SelfPost => ({ ts: "9.1", texts });

const ANSWER =
  "*Findings:* the checkout latency comes from the `orders` query - it scans 4M rows because the index on `created_at` was dropped in the last migration. :mag: I re-added the index and p95 went from 1.8s to 120ms.";

describe("normalizeText", () => {
  test("strips mrkdwn, links, mentions, emoji, case and punctuation", () => {
    expect(normalizeText("*Hello*, <@U123ABC> :tada: see <https://x.dev/a|the doc>! 🚀")).toBe("hello see the doc");
  });
  test("keeps numbers and non-latin letters", () => {
    expect(normalizeText("p95: 1.8s → 120ms, café")).toBe("p95 1 8s 120ms café");
  });
});

describe("isDuplicateReply", () => {
  test("the same answer reworded is a duplicate", () => {
    const reworded =
      "The checkout latency was caused by the orders query: it scanned 4M rows since the created_at index had been dropped in the last migration. I added the index back, and p95 dropped from 1.8s to 120ms.";
    expect(isDuplicateReply(reworded, [post(ANSWER)])).toBe(true);
  });
  test("a reworded answer that also says it updated the message is still a duplicate", () => {
    expect(isDuplicateReply(`${ANSWER} I updated everything in the message I posted in this thread.`, [post(ANSWER)])).toBe(true);
  });
  test("identical text up to formatting is a duplicate, even a short one", () => {
    expect(isDuplicateReply("Done - it's fixed!", [post("done, it's fixed")])).toBe(true);
  });
  test("a reply that adds real content is not", () => {
    const more = `${ANSWER} Separately, the nightly export job also times out: its connection pool is capped at two, so I raised the cap to ten and queued a rerun for tonight.`;
    expect(isDuplicateReply(more, [post(ANSWER)])).toBe(false);
  });
  test("a different answer on the same subject is not", () => {
    expect(isDuplicateReply("The checkout page is fine now, but the deploy is blocked: staging needs a manual approval from the platform team.", [post(ANSWER)])).toBe(false);
  });
  test("a short reply sharing a few words with the post is not a duplicate", () => {
    expect(isDuplicateReply("Yes, done.", [post("Yes - I checked and it is done")])).toBe(false);
  });
  test("a changed number or id in an otherwise repeated reply is new content", () => {
    const before = "Deployed build 4182 to staging, ran the smoke suite, all 37 checks passed, and opened the rollout ticket for the team.";
    const after = "Deployed build 4183 to staging, ran the smoke suite, all 36 checks passed, and opened the rollout ticket for the team.";
    // two changed numbers in a long repeat stay inside the budget; a reply built around new ids does not
    expect(repeatsPosted(after, [before])).toBe(true);
    expect(repeatsPosted("Build 4183 failed 6 checks: login, billing, export, search, upload, invite. Rolling back to 4182 now.", [before])).toBe(false);
  });
  test("no posts, or an empty reply, never matches", () => {
    expect(isDuplicateReply(ANSWER, [])).toBe(false);
    expect(isDuplicateReply("", [post(ANSWER)])).toBe(false);
    expect(isDuplicateReply("   ", [post("")])).toBe(false);
  });
  test("the words of several posts together can cover the reply", () => {
    const a = post("The index on created_at was dropped in a migration, which made the orders query scan four million rows.");
    const b = { ts: "9.2", texts: ["I re-added the index and the p95 latency went from 1.8s to 120ms for checkout."] };
    expect(isDuplicateReply("Checkout latency: the dropped created_at index made the orders query scan every row; re-added, p95 is down to 120ms from 1.8s.", [a, b])).toBe(true);
  });
  test("a blocks body counts as well as the text fallback", () => {
    const blocks = JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: ANSWER } }]);
    expect(isDuplicateReply(ANSWER, [post("fallback", blocksText(blocks))])).toBe(true);
  });
});

describe("blocksText", () => {
  test("reads section, markdown, context and rich text words; bad JSON is nothing", () => {
    const blocks = JSON.stringify([
      { type: "section", text: { type: "mrkdwn", text: "one" }, fields: [{ type: "mrkdwn", text: "two" }] },
      { type: "markdown", text: "three" },
      { type: "context", elements: [{ type: "mrkdwn", text: "four" }] },
      { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "five" }] }] },
    ]);
    expect(blocksText(blocks).split("\n")).toEqual(["one", "two", "three", "four", "five"]);
    expect(blocksText("not json")).toBe("");
    expect(blocksText(undefined)).toBe("");
  });
});

describe("applySelfPostCall", () => {
  const ok = (ts: string) => JSON.stringify({ ok: true, ts });
  const inThread = { channel: "C1", thread_ts: "1.1", text: "first answer" };

  test("a successful post into the turn's thread is recorded", () => {
    const posts = applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, "1.1");
    expect(posts).toEqual([{ ts: "5.5", texts: ["first answer"] }]);
  });
  test("a failed post, a top-level post and a post into another thread are not", () => {
    const failed = JSON.stringify({ ok: false, error: "channel_not_found" });
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: failed }, "1.1")).toEqual([]);
    expect(applySelfPostCall([], { method: "chat.postMessage", params: { channel: "C1", text: "x" }, answer: ok("5.5") }, "1.1")).toEqual([]);
    expect(applySelfPostCall([], { method: "chat.postMessage", params: { ...inThread, thread_ts: "2.2" }, answer: ok("5.5") }, "1.1")).toEqual([]);
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: "<html>" }, "1.1")).toEqual([]);
  });
  test("a turn with no thread records nothing", () => {
    expect(applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, undefined)).toEqual([]);
  });
  test("an update replaces the words of a message the turn posted, and ignores any other ts", () => {
    const first = applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, "1.1");
    const updated = applySelfPostCall(first, { method: "chat.update", params: { channel: "C1", ts: "5.5", text: "final answer" }, answer: ok("5.5") }, "1.1");
    expect(updated).toEqual([{ ts: "5.5", texts: ["final answer"] }]);
    const other = applySelfPostCall(updated, { method: "chat.update", params: { channel: "C1", ts: "7.7", text: "elsewhere" }, answer: ok("7.7") }, "1.1");
    expect(other).toBe(updated);
  });
  test("an update with neither text nor blocks keeps the words", () => {
    const first = applySelfPostCall([], { method: "chat.postMessage", params: inThread, answer: ok("5.5") }, "1.1");
    const after = applySelfPostCall(first, { method: "chat.update", params: { channel: "C1", ts: "5.5" }, answer: ok("5.5") }, "1.1");
    expect(after).toEqual(first);
  });
  test("a post's blocks are read as well as its text", () => {
    const blocks = JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: "from blocks" } }]);
    const posts = applySelfPostCall([], { method: "chat.postMessage", params: { ...inThread, blocks }, answer: ok("5.5") }, "1.1");
    expect(posts[0]?.texts).toEqual(["first answer", "from blocks"]);
  });
});
