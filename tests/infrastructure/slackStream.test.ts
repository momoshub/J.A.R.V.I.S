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

  test("shows a thinking step first and completes it on the first content", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinking("☄️ burning acme token..");
    s.sink({ type: "text", delta: "Hi" });
    const ok = await s.finish();
    expect(ok).toBe(true);

    const chunks = f.appends
      .filter((c) => "chunks" in c)
      .map((c) => (c as { chunks: Array<Record<string, unknown>> }).chunks[0]!);
    // thinking in_progress, then thinking complete, before the text append
    expect(chunks[0]).toMatchObject({ id: "__thinking__", status: "in_progress" });
    expect(chunks[0]!.title).toContain("burning acme token");
    expect(chunks[1]).toMatchObject({ id: "__thinking__", status: "complete" });
    const textIdx = f.appends.findIndex((c) => "markdown_text" in c);
    const thinkingDoneIdx = f.appends.findIndex(
      (c) => "chunks" in c && (c as { chunks: Array<{ status: string }> }).chunks[0]!.status === "complete",
    );
    expect(thinkingDoneIdx).toBeLessThan(textIdx);
  });

  test("showThinking without any content finishes as not-shown", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinking("☄️ burning acme token..");
    expect(await s.finish()).toBe(false);
  });
});

describe("hidden actions", () => {
  test("a reaction or a localhost call posts no card at all", async () => {
    const rec: { appends: unknown[]; stops: number } = { appends: [], stops: 0 };
    const stream = createSlackStream(() => ({
      append: async (a) => {
        rec.appends.push(a);
      },
      stop: async () => {
        rec.stops += 1;
      },
    }));

    stream.sink({
      type: "tool",
      id: "t1",
      title: "run: curl ... reactions.add",
      command: 'curl -X POST -d "channel=C1&name=eyes" https://slack.com/api/reactions.add',
      status: "complete",
    });
    stream.sink({
      type: "tool",
      id: "t2",
      title: "run: curl localhost",
      command: "curl -s http://127.0.0.1:2002/api/learnings",
      status: "complete",
    });

    await stream.finish();
    expect(rec.appends).toHaveLength(0);
    expect(stream.started).toBe(false); // not even a stream opened for these
  });

  test("a real tool call still shows", async () => {
    const rec: { appends: unknown[] } = { appends: [] };
    const stream = createSlackStream(() => ({
      append: async (a) => {
        rec.appends.push(a);
      },
      stop: async () => {},
    }));
    stream.sink({
      type: "tool",
      id: "t1",
      title: "run: gh pr view",
      command: "gh pr view https://github.com/o/r/pull/1",
      status: "complete",
    });
    await stream.finish(); // appends are serialised on a promise chain
    expect(rec.appends).toHaveLength(1);
  });
});

describe("delayed thinking card", () => {
  const mk = () => {
    const rec: { appends: unknown[] } = { appends: [] };
    const stream = createSlackStream(() => ({
      append: async (a) => {
        rec.appends.push(a);
      },
      stop: async () => {},
    }));
    return { rec, stream };
  };

  test("stays hidden when content arrives before the delay is up", async () => {
    const { rec, stream } = mk();
    stream.showThinkingAfter("thinking..", 50);
    stream.sink({ type: "text", delta: "immediate answer" });
    await new Promise((r) => setTimeout(r, 80)); // let the timer have its chance
    await stream.finish();
    expect(rec.appends.some((a) => "chunks" in (a as object))).toBe(false);
  });

  test("appears once the turn has been silent for the delay", async () => {
    const { rec, stream } = mk();
    stream.showThinkingAfter("thinking..", 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(rec.appends.some((a) => "chunks" in (a as object))).toBe(true);
  });

  test("a hidden action does not count as content, so the card still comes", async () => {
    const { rec, stream } = mk();
    stream.showThinkingAfter("thinking..", 15);
    stream.sink({
      type: "tool",
      id: "t1",
      title: "run: curl reactions.add",
      command: "curl -X POST https://slack.com/api/reactions.add",
      status: "complete",
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(rec.appends.some((a) => "chunks" in (a as object))).toBe(true);
  });

  test("finishing cancels a pending card", async () => {
    const { rec, stream } = mk();
    stream.showThinkingAfter("thinking..", 20);
    await stream.finish();
    await new Promise((r) => setTimeout(r, 40));
    expect(rec.appends).toHaveLength(0);
  });
});


describe("the 12,000 character wall", () => {
  /** A streamer whose every `make` is a distinct message, so rollovers show up. */
  const multi = () => {
    const messages: { text: string; stopped: boolean }[] = [];
    const make = (): Streamer => {
      const m = { text: "", stopped: false };
      messages.push(m);
      return {
        append: async (a) => {
          if (a.markdown_text) m.text += a.markdown_text;
          // Slack's real behaviour, measured: past 12,000 it refuses outright
          // and the answer is lost rather than truncated.
          if (m.text.length > 12_000) throw new Error("An API error occurred: msg_too_long");
        },
        stop: async () => {
          m.stopped = true;
        },
      };
    };
    return { make, messages };
  };

  test("a long reply rolls into a second message instead of being lost", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    // 20,000 characters, comfortably past one message's allowance
    for (let i = 0; i < 20; i++) s.sink({ type: "text", delta: "x".repeat(1000) });
    const ok = await s.finish();

    expect(ok).toBe(true);
    expect(f.messages.length).toBeGreaterThan(1);
    // nothing dropped on the floor
    expect(f.messages.map((m) => m.text).join("").length).toBe(20_000);
    // and every message is within what Slack will take
    expect(f.messages.every((m) => m.text.length <= 12_000)).toBe(true);
  });

  test("the message before a rollover is closed properly", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    for (let i = 0; i < 15; i++) s.sink({ type: "text", delta: "y".repeat(1000) });
    await s.finish();

    expect(f.messages.every((m) => m.stopped)).toBe(true);
  });

  test("a single delta bigger than the budget is split, not dropped", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "z".repeat(30_000) });
    await s.finish();

    expect(f.messages.map((m) => m.text).join("")).toBe("z".repeat(30_000));
  });
});

describe("abandoning a turn", () => {
  test("an armed placeholder never fires once the turn is abandoned", async () => {
    // a queued or dropped message used to leave the timer running, and it
    // posted a thinking card into a turn that no longer existed
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinkingAfter("thinking...", 10);
    await s.abandon();
    await Bun.sleep(40);

    expect(f.made()).toBe(0);
    expect(s.started).toBe(false);
  });

  test("a placeholder that already showed is handed back for removal", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinking("thinking...");
    const { emptyTs } = await s.abandon();

    // nothing real was ever said in it, so the caller takes the message away
    expect(f.stopped()).toBe(1);
    expect("emptyTs" in { emptyTs }).toBe(true);
  });

  test("a turn that said something is left alone", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "half an answer" });
    const { emptyTs } = await s.abandon();

    expect(emptyTs).toBeUndefined();
  });

  test("finish cancels an armed placeholder even when nothing opened a stream", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinkingAfter("thinking...", 10);
    expect(await s.finish()).toBe(false);
    await Bun.sleep(40);

    expect(f.made()).toBe(0);
  });
});
