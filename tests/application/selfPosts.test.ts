import { describe, expect, test } from "bun:test";
import { createSelfPosts, SELF_POSTS_MAX_THREADS, SELF_POSTS_TTL_MS } from "../../src/application/selfPosts.ts";

const post = (ts: string, text: string, thread = "1.1") => ({
  method: "chat.postMessage",
  params: { channel: "C1", thread_ts: thread, text },
  answer: JSON.stringify({ ok: true, ts }),
});

describe("selfPosts", () => {
  test("keeps a thread's posts until its turn ends", () => {
    const log = createSelfPosts();
    log.record("C1", "1.1", post("5.5", "answer"));
    expect(log.posts("C1", "1.1")).toEqual([{ ts: "5.5", texts: ["answer"] }]);
    log.clear("C1", "1.1");
    expect(log.posts("C1", "1.1")).toEqual([]);
  });
  test("threads and channels do not see each other's posts", () => {
    const log = createSelfPosts();
    log.record("C1", "1.1", post("5.5", "answer"));
    expect(log.posts("C1", "2.2")).toEqual([]);
    expect(log.posts("C2", "1.1")).toEqual([]);
  });
  test("a post aimed at another thread is not kept under the turn's own", () => {
    const log = createSelfPosts();
    log.record("C1", "1.1", post("5.5", "answer", "2.2"));
    expect(log.posts("C1", "1.1")).toEqual([]);
    expect(log.posts("C1", "2.2")).toEqual([]);
  });
  test("forgets a turn that never cleared after the ttl", () => {
    let now = 0;
    const log = createSelfPosts(() => now);
    log.record("C1", "1.1", post("5.5", "answer"));
    now = SELF_POSTS_TTL_MS;
    expect(log.posts("C1", "1.1")).toEqual([]);
  });
  test("is bounded: the oldest thread goes first", () => {
    const log = createSelfPosts();
    for (let i = 0; i <= SELF_POSTS_MAX_THREADS; i++) log.record("C1", `${i}.1`, post("5.5", "answer", `${i}.1`));
    expect(log.posts("C1", "0.1")).toEqual([]);
    expect(log.posts("C1", `${SELF_POSTS_MAX_THREADS}.1`)).toHaveLength(1);
  });
});
