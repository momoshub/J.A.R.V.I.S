import { describe, expect, test } from "bun:test";
import { createSelfPosts, SELF_POSTS_MAX_TURNS, SELF_POSTS_TTL_MS } from "../../src/application/selfPosts.ts";

const post = (ts: string, text: string, thread = "1.1") => ({
  method: "chat.postMessage",
  params: { channel: "C1", thread_ts: thread, text },
  answer: JSON.stringify({ ok: true, ts }),
});

describe("selfPosts", () => {
  test("keeps a turn's posts until it ends", () => {
    const log = createSelfPosts();
    log.record("turn-a", "1.1", post("5.5", "answer"));
    expect(log.posts("turn-a")).toEqual([{ ts: "5.5" }]);
    log.clear("turn-a");
    expect(log.posts("turn-a")).toEqual([]);
  });
  test("turns in the same thread do not see each other's posts", () => {
    const log = createSelfPosts();
    log.record("hand-back", "1.1", post("5.5", "answer"));
    expect(log.posts("turn-a")).toEqual([]);
    log.record("turn-a", "1.1", post("6.6", "mine"));
    expect(log.posts("turn-a")).toEqual([{ ts: "6.6" }]);
    expect(log.posts("hand-back")).toEqual([{ ts: "5.5" }]);
  });
  test("a post aimed at another thread is not kept under the turn's own", () => {
    const log = createSelfPosts();
    log.record("turn-a", "1.1", post("5.5", "answer", "2.2"));
    expect(log.posts("turn-a")).toEqual([]);
  });
  test("forgets a turn that never cleared after the ttl", () => {
    let now = 0;
    const log = createSelfPosts(() => now);
    log.record("turn-a", "1.1", post("5.5", "answer"));
    now = SELF_POSTS_TTL_MS;
    expect(log.posts("turn-a")).toEqual([]);
  });
  test("is bounded: the oldest turn goes first", () => {
    const log = createSelfPosts();
    for (let i = 0; i <= SELF_POSTS_MAX_TURNS; i++) log.record(`turn-${i}`, "1.1", post("5.5", "answer"));
    expect(log.posts("turn-0")).toEqual([]);
    expect(log.posts(`turn-${SELF_POSTS_MAX_TURNS}`)).toHaveLength(1);
  });
});
