import { describe, expect, test } from "bun:test";
import { VISIBLE_STEP_SLOTS, createSlackStream, rolloverCut, type Streamer } from "../../src/infrastructure/slack/stream.ts";

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
    s.sink({ type: "tool", id: "t1", title: "Run: 🏃 Listing files", details: "log at: l.jsonl - line 4", status: "in_progress" });
    s.sink({ type: "tool", id: "t1", title: "Run: 🏃 Listing files", status: "complete" });
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
      title: "Run: 🏃 Listing files · log line 4",
      status: "in_progress",
      details: "log at: l.jsonl",
    });
    expect(f.appends[3]).toEqual({ markdown_text: "world" });
  });

  test("a repeated step with a different log line per call still shares one card", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "t1", title: "Tool: 📖 Reading a file", details: "log at: l.jsonl - line 3", status: "in_progress" });
    s.sink({ type: "tool", id: "t2", title: "Tool: 📖 Reading a file", details: "log at: l.jsonl - line 9", status: "in_progress" });
    await s.finish();
    const calls = f.appends.flatMap((a) => (a as { chunks?: Array<Record<string, unknown>> }).chunks ?? []);
    expect(calls.map((c) => c.id)).toEqual(["t1", "t1"]);
    expect(calls[1]).toMatchObject({ title: "Tool: 📖 Reading a file (2 runs) · log line 3" });
  });

  test("repeats of the same step share one card that counts the runs", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "t1", title: "Querying a database", status: "in_progress" });
    s.sink({ type: "tool", id: "t1", title: "Querying a database", status: "complete" });
    s.sink({ type: "tool", id: "t2", title: "Querying a database", status: "in_progress" });
    s.sink({ type: "tool", id: "t3", title: "Querying a database", status: "in_progress" });
    s.sink({ type: "tool", id: "t2", title: "Querying a database", status: "complete" });
    s.sink({ type: "tool", id: "t3", title: "Querying a database", status: "error" });
    s.sink({ type: "tool", id: "t4", title: "Run: 🏃 Listing files", status: "in_progress" });
    await s.finish();
    const cards = f.appends.flatMap((a) => (a.chunks ?? []) as Array<Record<string, unknown>>);
    expect(cards.map((c) => [c.id, c.title, c.status])).toEqual([
      ["t1", "Querying a database", "in_progress"],
      ["t1", "Querying a database", "complete"],
      ["t1", "Querying a database (2 runs)", "in_progress"],
      ["t1", "Querying a database (3 runs)", "in_progress"],
      ["t1", "Querying a database (3 runs)", "error"],
      ["t4", "Run: 🏃 Listing files", "in_progress"],
    ]);
  });

  test("different titles are different steps, whatever log line they point at", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    const sql = "MCP: 🔌 pg-prod execute_sql";
    s.sink({ type: "tool", id: "q1", title: sql, details: "log at: l.jsonl - line 1", status: "in_progress" });
    s.sink({ type: "tool", id: "q2", title: "Tool: 📖 Reading a file", details: "log at: l.jsonl - line 5", status: "in_progress" });
    s.sink({ type: "tool", id: "q3", title: sql, details: "log at: l.jsonl - line 9", status: "in_progress" });
    await s.finish();
    const cards = f.appends.flatMap((a) => (a.chunks ?? []) as Array<Record<string, unknown>>);
    expect(cards.map((c) => [c.id, c.title, c.details])).toEqual([
      ["q1", `${sql} · log line 1`, "log at: l.jsonl"],
      ["q2", "Tool: 📖 Reading a file · log line 5", "log at: l.jsonl"],
      // the pointer is on the card already: Slack appends details, so it is not sent again
      ["q1", `${sql} (2 runs) · log line 1`, undefined],
    ]);
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
        ts: `ts-${messages.length}`,
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

  test("it reports each message and the part it showed", async () => {
    const short = multi();
    const a = createSlackStream(short.make);
    a.sink({ type: "text", delta: "hi" });
    await a.finish();
    expect(a.parts).toEqual([{ ts: "ts-1", text: "hi" }]);

    const long = multi();
    const b = createSlackStream(long.make);
    for (let i = 0; i < 20; i++) b.sink({ type: "text", delta: "x".repeat(1000) });
    await b.finish();
    expect(b.parts.length).toBe(long.messages.length);
    expect(b.parts.length).toBeGreaterThan(1);
    expect(b.parts.map((p) => p.text)).toEqual(long.messages.map((m) => m.text));
  });

  test("a Block Kit chunk is kept in its part as a fence, so the part can be rebuilt", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: 'before\n```blockkit\n[{"type":"divider"}]\n```\nafter' });
    await s.finish();
    const text = s.parts[0]?.text ?? "";
    expect(text).toContain("before");
    expect(text).toContain('```blockkit\n[{"type":"divider"}]\n```');
    expect(text).toContain("after");
  });

  test("the message before a rollover is closed properly", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    for (let i = 0; i < 15; i++) s.sink({ type: "text", delta: "y".repeat(1000) });
    await s.finish();

    expect(f.messages.every((m) => m.stopped)).toBe(true);
  });

  test("a rollover never cuts a word in half", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    const words = "restart once idle ".repeat(1200);
    s.sink({ type: "text", delta: words });
    await s.finish();

    expect(f.messages.length).toBeGreaterThan(1);
    expect(f.messages.map((m) => m.text).join("")).toBe(words);
    expect(f.messages.slice(0, -1).every((m) => m.text.endsWith(" "))).toBe(true);
  });

  test("a single delta bigger than the budget is split, not dropped", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "z".repeat(30_000) });
    await s.finish();

    expect(f.messages.map((m) => m.text).join("")).toBe("z".repeat(30_000));
  });
});

describe("task cards against the wall", () => {
  /** Slack counts cards toward the same 12,000 as text. */
  const multi = (cap = 12_000) => {
    const messages: { size: number; stopped: boolean }[] = [];
    const make = (): Streamer => {
      const m = { size: 0, stopped: false };
      messages.push(m);
      return {
        append: async (a) => {
          const add = (a.markdown_text?.length ?? 0) + (a.chunks ? JSON.stringify(a.chunks).length : 0);
          if (m.size + add > cap) throw new Error("An API error occurred: msg_too_long");
          m.size += add;
        },
        stop: async () => {
          m.stopped = true;
        },
      };
    };
    return { make, messages };
  };

  test("a tool-heavy turn rolls over instead of breaking the stream", async () => {
    const f = multi();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "digging in" });
    for (let i = 0; i < 60; i++) {
      s.sink({ type: "tool", id: `t${i}`, title: `Querying a database ${i}`, details: `log at: ${"q".repeat(400)} - line ${i}`, status: "in_progress" });
    }
    s.sink({ type: "text", delta: "the answer" });
    const ok = await s.finish();

    expect(ok).toBe(true);
    expect(f.messages.length).toBeGreaterThan(1);
    expect(f.messages.every((m) => m.stopped)).toBe(true);
  });

  test("a msg_too_long Slack counts differently is retried in a fresh message", async () => {
    // a tighter cap than our budget: our arithmetic says it fits, Slack disagrees
    const f = multi(5_000);
    const s = createSlackStream(f.make);
    for (let i = 0; i < 8; i++) s.sink({ type: "text", delta: "x".repeat(1000) });
    const ok = await s.finish();

    expect(ok).toBe(true);
    expect(f.messages.reduce((n, m) => n + m.size, 0)).toBe(8_000);
  });

  test("a payload too big even for a fresh message still fails cleanly", async () => {
    const f = multi(100);
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "x".repeat(500) });
    expect(await s.finish()).toBe(false);
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

describe("holding until the turn is working", () => {
  const hold = { holdUntilWorking: true };

  test("a short reply opens nothing, so the caller posts it or drops it", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, "✅", hold);
    s.sink({ type: "text", delta: "nothing to add" });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
  });

  test("a hidden action does not open it", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, "✅", hold);
    s.sink({
      type: "tool",
      id: "r",
      title: "react",
      command: "/x/bin/slack-react.sh C1 1.2 eyes",
      status: "complete",
    });
    expect(await s.finish()).toBe(false);
    expect(f.made()).toBe(0);
  });

  test("a visible tool opens it, with the held text first", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, "✅", hold);
    s.sink({ type: "text", delta: "on it" });
    expect(f.made()).toBe(0);
    s.sink({ type: "tool", id: "t1", title: "run: gh pr view", status: "in_progress" });
    expect(await s.finish()).toBe(true);
    expect(f.appends[0]).toEqual({ markdown_text: "on it" });
    expect(f.appends[1]?.chunks).toHaveLength(1);
  });

  test("text longer than a silence note opens it, all of it", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make, () => {}, "✅", hold);
    s.sink({ type: "text", delta: "a".repeat(50) });
    expect(f.made()).toBe(0);
    s.sink({ type: "text", delta: "b".repeat(50) });
    s.sink({ type: "text", delta: "c" });
    expect(await s.finish()).toBe(true);
    expect(f.appends.map((a) => a.markdown_text).join("")).toBe(`${"a".repeat(50)}${"b".repeat(50)}c`);
  });

  test("without the option it opens on the first event, as before", () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "hi" });
    expect(f.made()).toBe(1);
  });
});

describe("createSlackStream block kit", () => {
  test("a blockkit fence goes out as a blocks chunk between the text", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "look:\n```block" });
    s.sink({ type: "text", delta: 'kit\n[{"type":"divider"}]\n```\nthat is all' });
    expect(await s.finish()).toBe(true);
    const text = f.appends.map((a) => a.markdown_text ?? "").join("");
    expect(text).toBe("look:\nthat is all");
    const blocks = f.appends.flatMap((a) => (a.chunks ?? []) as { type: string; blocks?: unknown[] }[]);
    expect(blocks).toEqual([{ type: "blocks", blocks: [{ type: "divider" }] }]);
    // order: the intro text, then the blocks, then the rest
    const kinds = f.appends.map((a) => (a.chunks ? "blocks" : "text"));
    expect(kinds.indexOf("blocks")).toBeGreaterThan(0);
    expect(kinds.lastIndexOf("text")).toBeGreaterThan(kinds.indexOf("blocks"));
  });

  test("a broken fence streams as code instead of vanishing", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: "```blockkit\n{nope\n```\n" });
    await s.finish();
    const text = f.appends.map((a) => a.markdown_text ?? "").join("");
    expect(text).toContain("{nope");
    expect(f.appends.some((a) => a.chunks)).toBe(false);
  });
});

test("blocks Slack refuses are shown as code when they hold no words, and the stream carries on", async () => {
  const appends: Call[] = [];
  const streamer: Streamer = {
    append: async (a) => {
      if (a.chunks?.some((c) => c.type === "blocks")) throw new Error("An API error occurred: invalid_blocks");
      appends.push(a as Call);
    },
    stop: async () => {},
  };
  const s = createSlackStream(() => streamer);
  s.sink({ type: "text", delta: 'a\n```blockkit\n[{"type":"alert"}]\n```\nb' });
  expect(await s.finish()).toBe(true);
  const text = appends.map((x) => x.markdown_text ?? "").join("");
  expect(text).toContain('"alert"');
  expect(text.endsWith("b")).toBe(true);
});

describe("a blocks chunk Slack rejects does not kill the stream", () => {
  const TABLE = JSON.stringify([
    {
      type: "table",
      rows: [
        [{ type: "raw_text", text: "Name" }, { type: "raw_text", text: "Qty" }],
        [{ type: "raw_text", text: "widget" }, { type: "raw_text", text: "3" }],
      ],
    },
  ]);

  const refusing = (error: string) => {
    const appends: Call[] = [];
    let stops = 0;
    let opened = 0;
    const streamer: Streamer = {
      append: async (a) => {
        if (a.chunks?.some((c) => c.type === "blocks")) throw new Error(error);
        appends.push(a as Call);
      },
      stop: async () => {
        stops += 1;
      },
      ts: "1.1",
    };
    return { make: () => (opened++, streamer), appends, stops: () => stops, opened: () => opened };
  };

  // The live incident: Slack answered the table chunk with invalid_arguments
  // ("failed to match exactly one allowed schema"), which was not caught, so
  // the stream broke, the reply split in two and the table vanished.
  test("invalid_arguments: the table is written as its words, one message, nothing broken", async () => {
    const f = refusing("An API error occurred: invalid_arguments (failed to match exactly one allowed schema [json-pointer:/chunks/0])");
    const logs: string[] = [];
    const s = createSlackStream(f.make, (m) => logs.push(m));
    s.sink({ type: "text", delta: `before\n\`\`\`blockkit\n${TABLE}\n\`\`\`\nafter` });
    expect(await s.finish()).toBe(true);
    expect(f.opened()).toBe(1);
    const text = f.appends.map((x) => x.markdown_text ?? "").join("");
    expect(text).toContain("Name | Qty\nwidget | 3");
    expect(text.startsWith("before")).toBe(true);
    expect(text.endsWith("after")).toBe(true);
    expect(text).not.toContain("blockkit");
    expect(logs.some((l) => l.includes("blocks refused"))).toBe(true);
    // what the part recorded is words too, so the tidy-up never rebuilds the refused blocks
    expect(s.parts.map((p) => p.text).join("")).not.toContain("blockkit");
  });

  test("invalid_blocks: same", async () => {
    const f = refusing("An API error occurred: invalid_blocks");
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: `\`\`\`blockkit\n${TABLE}\n\`\`\`\n` });
    expect(await s.finish()).toBe(true);
    expect(f.appends.map((x) => x.markdown_text ?? "").join("")).toContain("widget | 3");
  });

  test("another failure still breaks the stream, as before", async () => {
    const f = refusing("An API error occurred: ratelimited");
    const s = createSlackStream(f.make);
    s.sink({ type: "text", delta: `\`\`\`blockkit\n${TABLE}\n\`\`\`\n` });
    expect(await s.finish()).toBe(false);
  });

  test("a table with an empty cell is fixed before it is sent, so nothing is refused", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    const table = JSON.stringify([{ type: "table", rows: [[{ type: "raw_text", text: "" }, { type: "raw_text", text: "Qty" }]] }]);
    s.sink({ type: "text", delta: `\`\`\`blockkit\n${table}\n\`\`\`\n` });
    expect(await s.finish()).toBe(true);
    const chunk = f.appends.find((a) => a.chunks)?.chunks?.[0] as { blocks: { rows: { text: string }[][] }[] };
    expect(chunk.blocks[0]?.rows[0]?.map((c) => c.text)).toEqual(["-", "Qty"]);
  });
});

describe("the steps a finished message showed", () => {
  test("each card counts once, however often it is updated", () => {
    const stream = createSlackStream(fakeStreamer().make);
    stream.sink({ type: "tool", id: "a", title: "Run: 🏃 Listing files", status: "in_progress" });
    stream.sink({ type: "tool", id: "a", title: "Run: 🏃 Listing files", status: "complete" });
    stream.sink({ type: "tool", id: "b", title: "Run: 🏃 Reading x", status: "in_progress" });
    stream.sink({ type: "tool", id: "b", title: "Run: 🏃 Reading x", status: "error" });

    expect(stream.steps).toEqual([
      { title: "Run: 🏃 Listing files", failed: false },
      { title: "Run: 🏃 Reading x", failed: true },
    ]);
  });

  test("the thinking placeholder is not a step anyone took", () => {
    const stream = createSlackStream(fakeStreamer().make);
    stream.showThinking("thinking…");
    stream.sink({ type: "tool", id: "a", title: "Run: 🏃 Listing files", status: "complete" });
    expect(stream.steps.map((s) => s.title)).toEqual(["Run: 🏃 Listing files"]);
  });

  test("a turn that only talked has no steps to collapse", () => {
    const stream = createSlackStream(fakeStreamer().make);
    stream.sink({ type: "text", delta: "just an answer" });
    expect(stream.steps).toEqual([]);
  });
});

describe("the cards a running message shows", () => {
  type Card = { id: string; title: string; status: string; details?: string };
  /**
   * What Slack would show: a card per id in the order the ids first appeared,
   * an update to a known id rewriting title and status in place, and APPENDING
   * its details to the card's (measured against the real API).
   */
  const column = (appends: Call[]): Card[] => {
    const cards = new Map<string, Card>();
    for (const a of appends)
      for (const c of (a.chunks ?? []) as Array<Card & { type: string }>) {
        if (c.type !== "task_update" || c.id === "__thinking__") continue;
        const was = cards.get(c.id);
        cards.set(c.id, { id: c.id, title: c.title, status: c.status, details: c.details === undefined ? was?.details : (was?.details ?? "") + c.details });
      }
    return [...cards.values()];
  };
  const run = (s: ReturnType<typeof createSlackStream>, n: number, title = (i: number) => `Step ${i}`) => {
    for (let i = 1; i <= n; i++) {
      s.sink({ type: "tool", id: `t${i}`, title: title(i), details: `log at: l.jsonl - line ${i}`, status: "in_progress" });
      s.sink({ type: "tool", id: `t${i}`, title: title(i), status: "complete" });
    }
  };

  test("holds five cards and hides the older steps", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 8);
    await s.finish();
    const cards = column(f.appends);
    expect(cards).toHaveLength(VISIBLE_STEP_SLOTS);
    expect(cards.map((c) => c.title).sort()).toEqual([4, 5, 6, 7, 8].map((n) => `Step ${n} · log line ${n}`));
    expect(cards.every((c) => c.status === "complete")).toBe(true);
  });

  test("a turn of five steps or fewer gets one card per step, on its own id", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 5);
    await s.finish();
    expect(column(f.appends).map((c) => c.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  test("a running step shows next to the four latest finished ones", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 7);
    s.sink({ type: "tool", id: "now", title: "Running now", status: "in_progress" });
    await s.finish();
    const cards = column(f.appends);
    expect(cards).toHaveLength(VISIBLE_STEP_SLOTS);
    expect(cards.filter((c) => c.status === "in_progress").map((c) => c.title)).toEqual(["Running now"]);
    expect(cards.filter((c) => c.status === "complete").map((c) => c.title).sort()).toEqual([4, 5, 6, 7].map((n) => `Step ${n} · log line ${n}`));
  });

  test("a step that takes a slot over shows its own log line in the title and adds no details", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 6);
    await s.finish();
    const chunks = f.appends.flatMap((a) => (a.chunks ?? []) as Array<Record<string, unknown>>);
    const six = chunks.filter((c) => String(c.title).startsWith("Step 6"));
    // the finishing update carries no pointer, and a title replaces the last one: the line stays
    expect(six.map((c) => c.title)).toEqual(["Step 6 · log line 6", "Step 6 · log line 6"]);
    // Slack appends `details`, so the pointer goes out once per card and never again
    expect(chunks.filter((c) => c.details !== undefined)).toHaveLength(VISIBLE_STEP_SLOTS);
    expect(six.every((c) => c.details === undefined)).toBe(true);
    expect(chunks.find((c) => c.id === "t1" && c.details)?.details).toBe("log at: l.jsonl");
  });

  test("a long title is clipped to leave room for the log line", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "a", title: "x".repeat(200), details: "log at: l.jsonl - line 123", status: "in_progress" });
    await s.finish();
    const title = String(((f.appends[0]?.chunks ?? [])[0] as { title: string }).title);
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith(" · log line 123")).toBe(true);
  });

  test("a step that takes a slot over does not inherit the line of the one it replaced", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 5);
    s.sink({ type: "tool", id: "x", title: "No pointer", status: "in_progress" });
    await s.finish();
    const chunks = f.appends.flatMap((a) => (a.chunks ?? []) as Array<Record<string, unknown>>);
    expect(chunks[chunks.length - 1]).toMatchObject({ id: "t1", title: "No pointer" });
  });

  test("a card with no log pointer shows no details", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "a", title: "A", status: "in_progress" });
    s.sink({ type: "tool", id: "a", title: "A", status: "complete" });
    await s.finish();
    expect(column(f.appends)[0]?.details).toBeUndefined();
  });

  test("every step in progress stays visible, however many", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    for (let i = 1; i <= 9; i++) s.sink({ type: "tool", id: `p${i}`, title: `Parallel ${i}`, status: "in_progress" });
    run(s, 7);
    await s.finish();
    const cards = column(f.appends);
    expect(cards.filter((c) => c.status === "in_progress")).toHaveLength(9);
    // nothing finished can be kept beside them: a card cannot be removed, only reused
    expect(cards.filter((c) => c.status === "complete")).toHaveLength(1);
  });

  test("a slow step is never taken over while it runs, and finishes on its own card", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "slow", title: "Slow one", status: "in_progress" });
    run(s, 9);
    s.sink({ type: "tool", id: "slow", title: "Slow one", status: "complete" });
    await s.finish();
    const cards = column(f.appends);
    expect(cards.filter((c) => c.title === "Slow one")).toHaveLength(1);
    expect(cards.filter((c) => c.status === "in_progress")).toHaveLength(0);
    expect(cards).toHaveLength(VISIBLE_STEP_SLOTS);
  });

  test("a step that fails counts as finished, and keeps its error when it is reused", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    for (let i = 1; i <= 7; i++) {
      s.sink({ type: "tool", id: `t${i}`, title: `Step ${i}`, status: "in_progress" });
      s.sink({ type: "tool", id: `t${i}`, title: `Step ${i}`, status: i % 2 ? "error" : "complete" });
    }
    await s.finish();
    const cards = column(f.appends);
    expect(cards).toHaveLength(VISIBLE_STEP_SLOTS);
    expect(cards.map((c) => [c.title, c.status]).sort()).toEqual([
      ["Step 3", "error"],
      ["Step 4", "complete"],
      ["Step 5", "error"],
      ["Step 6", "complete"],
      ["Step 7", "error"],
    ]);
    // steps 6 and 7 took over the slots of the two oldest finished steps
    expect(cards.map((c) => c.id).sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  test("a late finish for a step whose card was taken over adds no card", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 7);
    s.sink({ type: "tool", id: "t1", title: "Step 1", status: "error" });
    s.sink({ type: "tool", id: "t2", title: "Step 2", status: "complete" });
    await s.finish();
    const cards = column(f.appends);
    expect(cards).toHaveLength(VISIBLE_STEP_SLOTS);
    expect(cards.map((c) => c.title).sort()).toEqual([3, 4, 5, 6, 7].map((n) => `Step ${n} · log line ${n}`));
  });

  test("a repeated step whose card scrolled away comes back as a fresh card with its count", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.sink({ type: "tool", id: "q1", title: "Query", command: "q", status: "in_progress" });
    s.sink({ type: "tool", id: "q1", title: "Query", command: "q", status: "complete" });
    run(s, 6);
    s.sink({ type: "tool", id: "q2", title: "Query", command: "q", status: "in_progress" });
    await s.finish();
    const cards = column(f.appends);
    expect(cards.filter((c) => c.title === "Query (2 runs)")).toHaveLength(1);
    expect(cards.filter((c) => c.status === "in_progress")).toHaveLength(1);
  });

  test("a long grouped title keeps its run count beside the log line", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    const title = "Q".repeat(190);
    s.sink({ type: "tool", id: "g1", title, command: "q", details: "log at: l.jsonl - line 12", status: "in_progress" });
    s.sink({ type: "tool", id: "g2", title, command: "q", details: "log at: l.jsonl - line 40", status: "in_progress" });
    await s.finish();
    const chunks = f.appends.flatMap((a) => (a.chunks ?? []) as Array<{ title: string }>);
    const last = chunks[chunks.length - 1]?.title ?? "";
    expect(last.length).toBeLessThanOrEqual(200);
    expect(last.endsWith(" (2 runs) · log line 12")).toBe(true);
  });

  test("the summary still counts every step, not the visible ones", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    run(s, 12);
    await s.finish();
    expect(s.steps).toHaveLength(12);
    expect(s.steps.map((x) => x.title)[0]).toBe("Step 1");
  });

  test("the thinking card is not part of the limit", async () => {
    const f = fakeStreamer();
    const s = createSlackStream(f.make);
    s.showThinking("thinking…");
    run(s, 7);
    await s.finish();
    const all = f.appends.flatMap((a) => (a.chunks ?? []) as Array<{ id: string }>);
    expect(all.some((c) => c.id === "__thinking__")).toBe(true);
    expect(column(f.appends)).toHaveLength(VISIBLE_STEP_SLOTS);
  });
});

describe("step cards across a rollover", () => {
  /** A Slack that takes ~`cap` characters a message, with the cards each message holds. */
  const rolling = (cap: number) => {
    const messages: { size: number; cards: Array<{ id: string; title: string; details?: string }> }[] = [];
    const make = (): Streamer => {
      const m = { size: 0, cards: [] as Array<{ id: string; title: string; details?: string }> };
      messages.push(m);
      return {
        append: async (a) => {
          const add = (a.markdown_text?.length ?? 0) + (a.chunks ? JSON.stringify(a.chunks).length : 0);
          if (m.size + add > cap) throw new Error("An API error occurred: msg_too_long");
          m.size += add;
          for (const c of (a.chunks ?? []) as Array<{ id: string; title: string; details?: string }>) {
            const was = m.cards.find((x) => x.id === c.id);
            if (was) {
              was.title = c.title;
              if (c.details !== undefined) was.details = (was.details ?? "") + c.details;
            } else m.cards.push({ id: c.id, title: c.title, details: c.details });
          }
        },
        stop: async () => {},
      };
    };
    return { make, messages };
  };

  test("a card that first appears in the continuation message carries the log file there too", async () => {
    const f = rolling(2_000);
    const s = createSlackStream(f.make);
    const long = "x".repeat(150);
    for (let i = 1; i <= 12; i++) {
      s.sink({ type: "tool", id: `t${i}`, title: `Step ${i} ${long}`, details: `log at: ${"f".repeat(80)} - line ${i}`, status: "in_progress" });
      s.sink({ type: "tool", id: `t${i}`, title: `Step ${i} ${long}`, status: "complete" });
    }
    await s.finish();
    expect(f.messages.length).toBeGreaterThan(1);
    for (const m of f.messages) {
      expect(m.cards.length).toBeGreaterThan(0);
      for (const c of m.cards) expect(c.details).toBe(`log at: ${"f".repeat(80)}`);
    }
  });

  test("no message ever holds more than five cards", async () => {
    const f = rolling(2_000);
    const s = createSlackStream(f.make);
    const long = "x".repeat(150);
    for (let i = 1; i <= 12; i++) {
      s.sink({ type: "tool", id: `t${i}`, title: `Step ${i} ${long}`, details: `log at: ${"f".repeat(80)} - line ${i}`, status: "in_progress" });
      s.sink({ type: "tool", id: `t${i}`, title: `Step ${i} ${long}`, status: "complete" });
    }
    await s.finish();
    for (const m of f.messages) expect(m.cards.length).toBeLessThanOrEqual(VISIBLE_STEP_SLOTS);
  });
});

describe("what the run cost", () => {
  const usage = {
    model: "claude-opus-5-5",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 1.5,
    durationMs: 1000,
  };

  test("it is kept for the footer", () => {
    const stream = createSlackStream(fakeStreamer().make);
    stream.sink({ type: "usage", usage });
    expect(stream.usage?.costUsd).toBe(1.5);
  });

  test("it never opens a stream, and never counts as content", () => {
    // it arrives at the very end of EVERY run, including ones that said
    // nothing - opening a message for it would post an empty reply
    const f = fakeStreamer();
    const stream = createSlackStream(f.make);
    stream.sink({ type: "usage", usage });
    expect(f.made()).toBe(0);
    expect(stream.started).toBe(false);
  });
});

describe("rolloverCut", () => {
  test("everything when it fits", () => {
    expect(rolloverCut("hello world", 50, false)).toBe(11);
  });

  test("after a line break first, then a space", () => {
    expect(rolloverCut("ab cd\nef gh", 10, false)).toBe(6);
    expect(rolloverCut("I restart once idle", 12, false)).toBe(10);
  });

  test("no break in reach: roll over first, or hard cut a fresh message", () => {
    expect(rolloverCut("xxxxxxxx", 4, false)).toBe(0);
    expect(rolloverCut("xxxxxxxx", 4, true)).toBe(4);
  });
});
