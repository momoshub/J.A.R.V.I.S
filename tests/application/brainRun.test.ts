import { describe, expect, test } from "bun:test";
import { runForBrain, STARTED_MESSAGE } from "../../src/application/brainRun.ts";
import { blockKitReply } from "../../src/domain/blockKit.ts";

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

  // A handed-off errand that then failed used to be logged and nothing else, so
  // the thread sat on "investigating" forever and the next turn ran it again.
  test("a handed-off errand that fails says so in the thread", async () => {
    const { posts, post } = recorder();
    const logged: unknown[] = [];
    let fail: (e: Error) => void = () => {};
    await runForBrain({
      quiet: false,
      start: () => new Promise<string>((_, reject) => (fail = reject)),
      post,
      handoffMs: 5,
      onLateError: (e) => void logged.push(e),
    });
    fail(new Error("claude CLI exited with code 137: no output"));
    await new Promise((r) => setTimeout(r, 0));
    expect(logged).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("claude CLI exited with code 137");
  });

  test("a Block Kit reply posts as the fence but comes back to the brain as its words", async () => {
    const { posts, post } = recorder();
    const reply = blockKitReply("*cpu* fine", [{ type: "divider" }]);
    const errand = await runForBrain({ quiet: false, start: async () => reply, post, handoffMs: 1000, onLateError: () => {} });
    expect(errand).toEqual({ result: "*cpu* fine", posted: true });
    expect(posts).toEqual([reply]);
    const tool = await runForBrain({ quiet: true, start: async () => reply, post, handoffMs: 1000, onLateError: () => {} });
    expect(tool.result).toBe("*cpu* fine");
  });
});
