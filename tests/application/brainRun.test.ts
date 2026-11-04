import { describe, expect, test } from "bun:test";
import { runForBrain, STARTED_MESSAGE } from "../../src/application/brainRun.ts";

const recorder = () => {
  const posts: string[] = [];
  return { posts, post: async (text: string) => void posts.push(text) };
};

describe("runForBrain", () => {
  test("a quiet command answers the caller and posts nothing", async () => {
    const { posts, post } = recorder();
    let gotReply: unknown = "unset";
    const out = await runForBrain({
      quiet: true,
      start: async (reply) => {
        gotReply = reply;
        return "the page body";
      },
      post,
      handoffMs: 1000,
      onLateError: () => {},
    });
    expect(out).toEqual({ result: "the page body", posted: false });
    expect(gotReply).toBeUndefined();
    expect(posts).toEqual([]);
  });

  test("a fast errand like users is posted to the thread and says so", async () => {
    const { posts, post } = recorder();
    const out = await runForBrain({
      quiet: false,
      start: async () => "- <@U1> - *owner*",
      post,
      handoffMs: 1000,
      onLateError: () => {},
    });
    expect(posts).toEqual(["- <@U1> - *owner*"]);
    expect(out).toEqual({ result: "- <@U1> - *owner*", posted: true });
  });

  test("an empty result posts nothing and claims nothing was posted", async () => {
    const { posts, post } = recorder();
    const out = await runForBrain({ quiet: false, start: async () => "  ", post, handoffMs: 1000, onLateError: () => {} });
    expect(posts).toEqual([]);
    expect(out.posted).toBe(false);
  });

  test("a slow errand is handed off and posts when it finishes", async () => {
    const { posts, post } = recorder();
    let finish: (s: string) => void = () => {};
    const out = await runForBrain({
      quiet: false,
      start: () => new Promise<string>((r) => (finish = r)),
      post,
      handoffMs: 5,
      onLateError: () => {},
    });
    expect(out).toEqual({ result: STARTED_MESSAGE, posted: true });
    expect(posts).toEqual([]);
    finish("review done");
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual(["review done"]);
  });
});
