import { describe, expect, test } from "bun:test";
import {
  applySelfPostCall,
  blocksText,
  isDuplicateReply,
  isDuplicateStream,
  MAX_FRESH_SHARE,
  MIN_POST_COVERAGE,
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
    const after = "Deployed build 4183 to staging, ran the smoke suite, all 37 checks passed, and opened the rollout ticket for the team.";
    expect(repeatsPosted(before, [before])).toBe(true);
    expect(repeatsPosted(after, [before])).toBe(false);
  });
  test("no posts, or an empty reply, never matches", () => {
    expect(isDuplicateReply(ANSWER, [])).toBe(false);
    expect(isDuplicateReply("", [post(ANSWER)])).toBe(false);
    expect(isDuplicateReply("   ", [post("")])).toBe(false);
  });
  test("the words of several posts together can cover the reply", () => {
    const a = post("The index on created_at was dropped in a migration, which made the orders query scan four million rows.");
    const b = { ts: "9.2", texts: ["I re-added the index and the p95 latency went from 1.8s to 120ms for checkout."] };
    expect(isDuplicateReply("Checkout latency: the index on created_at was dropped in a migration, which made the orders query scan four million rows; I re-added the index and the p95 latency went from 1.8s to 120ms for checkout.", [a, b])).toBe(true);
  });
  test("a blocks body counts as well as the text fallback", () => {
    const blocks = JSON.stringify([{ type: "section", text: { type: "mrkdwn", text: ANSWER } }]);
    expect(isDuplicateReply(ANSWER, [post("fallback", blocksText(blocks))])).toBe(true);
  });
});

describe("a reply that repeats the post, in any language", () => {
  const VI_POST =
    "dạ stuck thật anh :man-bowing::skin-tone-2: sub agent Fable cũ chết theo turn hôm đó, 2h21m không branch, không PR. lỗi của em: chỉ watch file kết quả, không watch con agent nên nó chết mà không ai biết\n- đã chạy lại Fable dạng process riêng, không chết theo turn nữa\n- 2 watch: một cái báo khi bài xong, một cái báo ngay nếu writer chết giữa chừng\n- lỗ này nằm ở skill blog, em đã gửi bug report #4 để anh duyệt sửa\nxong em gửi tiêu đề, PR, ảnh diagram + nút Publish/Revise vào thread này, tối đa 3 tiếng :coffee:";
  // Captured from a real thread: the reword adds function words and one sentence about the post itself.
  const VI_REPLY =
    "Dạ stuck thật anh :man-bowing::skin-tone-2: Sub agent Fable cũ chết theo turn hôm đó. Sau 2h21m vẫn không có branch, không có PR nào. Lỗi của em: em chỉ watch file kết quả, không watch chính con agent, nên nó chết mà không ai biết. Em cập nhật hết trong message em đã post ở thread này rồi.  - em đã chạy lại Fable thành một process riêng, lần này không chết theo turn nữa - có 2 watch: một cái báo khi bài xong, một cái báo ngay nếu writer chết giữa chừng - lỗ này nằm ở skill blog, em đã gửi bug report #4 chờ anh duyệt sửa  Bài xong em gửi vào thread này tiêu đề, link PR, ảnh diagram và nút Publish/Revise, tối đa 3 tiếng :coffee:";

  test("the real Vietnamese case is dropped", () => {
    expect(isDuplicateReply(VI_REPLY, [post(VI_POST)])).toBe(true);
  });
  test("a Vietnamese reply adding a new sentence with a number, a link or a name is kept", () => {
    expect(isDuplicateReply(`${VI_REPLY} Em cũng đã sửa xong lỗi thanh toán, PR #87 đang chờ review.`, [post(VI_POST)])).toBe(false);
    expect(isDuplicateReply(`${VI_REPLY} Chi tiết ở https://github.com/acme/blog/pull/12 nhé anh.`, [post(VI_POST)])).toBe(false);
    expect(isDuplicateReply(`${VI_REPLY} Em đã nhờ Hoàng xem giúp phần này luôn.`, [post(VI_POST)])).toBe(false);
  });
  test("an unrelated Vietnamese reply is kept", () => {
    expect(isDuplicateReply("Dạ em kiểm tra rồi anh, server staging vẫn chạy bình thường, không có lỗi nào trong log từ sáng đến giờ cả.", [post(VI_POST)])).toBe(false);
  });
  test("an English reword is still dropped", () => {
    const reworded =
      "The checkout latency was caused by the orders query: it scanned 4M rows since the created_at index had been dropped in the last migration. I added the index back, and p95 dropped from 1.8s to 120ms.";
    expect(isDuplicateReply(reworded, [post(ANSWER)])).toBe(true);
  });
  test("an English reply adding a new sentence with a number, a link or a name is kept", () => {
    const reworded = "The checkout latency was caused by the orders query: it scanned 4M rows since the created_at index had been dropped in the last migration. I added the index back, and p95 dropped from 1.8s to 120ms.";
    expect(isDuplicateReply(`${reworded} I also bumped the pool to 40 connections.`, [post(ANSWER)])).toBe(false);
    expect(isDuplicateReply(`${reworded} The runbook is at https://wiki.example.com/runbooks/orders now.`, [post(ANSWER)])).toBe(false);
    expect(isDuplicateReply(`${reworded} I asked Priya to review the migration.`, [post(ANSWER)])).toBe(false);
  });
  test("a name already in the post is not a new fact", () => {
    const posted = "Thanks to Priya for the review. The orders query scanned four million rows because the created_at index was dropped; p95 is back to 120ms from 1.8s.";
    const reply = "Thanks to Priya for the review. The orders query scanned four million rows because the created_at index was dropped, and p95 is back to 120ms from 1.8s.";
    expect(isDuplicateReply(reply, [post(posted)])).toBe(true);
  });
});

describe("the two-sided check: the post is covered by the reply, and the reply stays close to the post", () => {
  const REWORDED =
    "The checkout latency was caused by the orders query: it scanned 4M rows since the created_at index had been dropped in the last migration. I added the index back, and p95 dropped from 1.8s to 120ms.";
  const LONG_POST =
    "Deploy summary for the week: the billing service moved to the new queue, retries now back off for up to ten minutes, the dashboard shows lag per consumer, the old workers were scaled down on Tuesday, the alerts page the platform rotation instead of everyone, and the runbook covers rollback step by step.";

  test("a reword with one number changed is kept", () => {
    expect(repeatsPosted(REWORDED.replace("1.8s", "2.4s"), [ANSWER])).toBe(false);
  });
  test("a post plus a new paragraph with a real new fact is kept", () => {
    const more = `${REWORDED}\n\nSeparately, the nightly export job also times out: its connection pool is capped at two, so I raised the cap to ten and queued a rerun for tonight.`;
    expect(isDuplicateReply(more, [post(ANSWER)])).toBe(false);
  });
  test("a post plus a short new sentence with a new name, number or link is kept", () => {
    expect(isDuplicateReply(`${REWORDED} I asked Priya to review it.`, [post(ANSWER)])).toBe(false);
    expect(isDuplicateReply(`${REWORDED} Pool is now 40.`, [post(ANSWER)])).toBe(false);
    expect(isDuplicateReply(`${REWORDED} See https://wiki.example.com/orders.`, [post(ANSWER)])).toBe(false);
  });
  test("a short reply to a long post is kept: it holds too little of the post", () => {
    // every word is in the post, no hard token, 0% fresh: only the post-coverage tells it apart from a repeat
    const short = "Retries now back off for up to ten minutes, and the alerts page the platform rotation instead of everyone.";
    expect(isDuplicateReply(short, [post(LONG_POST)])).toBe(false);
    expect(isDuplicateReply(LONG_POST, [post(LONG_POST)])).toBe(true);
  });
  test("a reply that covers the post but says much more is kept: too many fresh words", () => {
    const wordy = `${LONG_POST} Unrelatedly, yesterday's outage report blamed expired certificates, so security rotated credentials across regions, finance paused invoices temporarily, support drafted apology emails, legal reviewed contract clauses, and marketing postponed Thursday's webinar until further notice.`;
    expect(isDuplicateReply(wordy, [post(LONG_POST)])).toBe(false);
  });
  test("the real Vietnamese fixture is covered by a wide margin on both sides of the numbers", () => {
    // fresh share of the reply about 24%, post-coverage about 0.95: far from both bounds' failing side
    expect(MAX_FRESH_SHARE).toBeGreaterThan(0.24);
    expect(MIN_POST_COVERAGE).toBeLessThanOrEqual(0.9);
  });
});

describe("isDuplicateStream", () => {
  const REWORDED =
    "The checkout latency was caused by the orders query: it scanned 4M rows since the created_at index had been dropped in the last migration. I added the index back, and p95 dropped from 1.8s to 120ms.";
  test("a stream of only the reply (and silence) may be taken back", () => {
    expect(isDuplicateStream(REWORDED, [REWORDED], [post(ANSWER)])).toBe(true);
    expect(isDuplicateStream(REWORDED, ["", REWORDED, "NO_REPLY"], [post(ANSWER)])).toBe(true);
    expect(isDuplicateStream(REWORDED, [], [post(ANSWER)])).toBe(true);
  });
  test("streamed narration that is in neither the post nor the reply keeps the stream", () => {
    const heads = "Heads up: staging is also down, I paged on-call.";
    expect(isDuplicateStream(REWORDED, [heads, REWORDED], [post(ANSWER)])).toBe(false);
    // one message holding both, as a stream that did not roll over does
    expect(isDuplicateStream(REWORDED, [`${heads}\n\n${REWORDED}`], [post(ANSWER)])).toBe(false);
    // a short line is not covered either
    expect(isDuplicateStream(REWORDED, ["Checking the logs.", REWORDED], [post(ANSWER)])).toBe(false);
  });
  test("a reply that is not a repeat never drops the stream", () => {
    expect(isDuplicateStream("Something else entirely, with 3 new facts.", ["x"], [post(ANSWER)])).toBe(false);
    expect(isDuplicateStream(REWORDED, [REWORDED], [])).toBe(false);
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
