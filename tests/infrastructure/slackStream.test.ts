import { describe, expect, test } from "bun:test";
import { createSlackStream, type Streamer } from "../../src/infrastructure/slack/stream.ts";

type Call = { markdown_text?: string; chunks?: unknown[] };

const fakeStreamer = (opts: { failAppend?: boolean; failStop?: boolean } = {}) => {
  const appends: Call[] = [];
  let stopped = 0;
  let made = 0;
  const streamer: Streamer = {
    append: async (a) => {
      if (opts.failAppend) throw new Error("append boom");
      appends.push(a as Call);
    },
    stop: async () => {
      if (opts.failStop) throw new Error("stop boom");
      stopped += 1;
    },
  };
  const make = () => {
    made += 1;
    return streamer;
  };
  return { make, appends, stopped: () => stopped, made: () => made };
};

describe("createSlackStream", () => {
  test("does not open a stream until an event arrives", () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    expect(s.started).toBe(false);
    expect(f.made()).toBe(0);
  });

  test("streams text and tool cards, then stops", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "Hello " });
    s.sink({ type: "tool", id: "t1", title: "run: ls", details: "ls", status: "in_progress" });
    s.sink({ type: "tool", id: "t1", title: "run: ls", status: "complete" });
    s.sink({ type: "text", delta: "world" });
    const ok = await s.finish();
    expect(ok).toBe(true);
    expect(s.started).toBe(true);
    expect(f.stopped()).toBe(1);
    expect(f.appends[0]).toEqual({ markdown_text: "Hello " });
    const toolCall = f.appends[1] as { chunks: Array<Record<string, unknown>> };
    expect(toolCall.chunks[0]).toMatchObject({
      type: "task_update",
      id: "t1",
      title: "run: ls",
      status: "in_progress",
      details: "ls",
    });
    expect(f.appends[3]).toEqual({ markdown_text: "world" });
  });

  test("skips empty text deltas", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "" });
    // an empty delta still opens the stream lazily via ensure(); assert no append queued
    await s.finish();
    expect(f.appends).toHaveLength(0);
  });

  test("finish returns false when an append fails", async () => {
    const f = fakeStreamer({ failAppend: true });
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "hi" });
    expect(await s.finish()).toBe(false);
  });

  test("finish returns false when stop fails", async () => {
    const f = fakeStreamer({ failStop: true });
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "hi" });
    expect(await s.finish()).toBe(false);
  });

  test("finish on an unopened stream returns false", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    expect(await s.finish()).toBe(false);
  });
});
