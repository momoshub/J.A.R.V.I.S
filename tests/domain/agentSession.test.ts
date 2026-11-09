import { describe, expect, test } from "bun:test";
import {
  AGENT_SESSION_STOPPED,
  planSessionStop,
  sessionStoppedLog,
  sessionThreadKey,
} from "../../src/domain/agentSession.ts";
import { forHowLong } from "../../src/domain/runControl.ts";

const press = {
  type: AGENT_SESSION_STOPPED,
  channel: "C123",
  thread_ts: "100.1",
  user: "U9",
  streaming_message_ts: ["200.2"],
  event_ts: "300.3",
};

describe("planSessionStop", () => {
  test("a real press becomes a thread key, a presser and the streams to close", () => {
    const plan = planSessionStop(press);
    expect(plan).toEqual({
      kind: "stop",
      key: "C123:100.1",
      channel: "C123",
      threadTs: "100.1",
      by: "U9",
      streams: ["200.2"],
    });
  });

  test("a press with no stream open is still a stop", () => {
    // Slack sends an empty array when nothing was streaming; the work still
    // has to stop
    const plan = planSessionStop({ ...press, streaming_message_ts: [] });
    expect(plan.kind).toBe("stop");
    expect(plan.kind === "stop" && plan.streams).toEqual([]);
  });

  test("an absent streaming_message_ts is the same as an empty one", () => {
    const plan = planSessionStop({ ...press, streaming_message_ts: undefined });
    expect(plan.kind === "stop" && plan.streams).toEqual([]);
  });

  test("junk entries are dropped rather than sent to the API", () => {
    const plan = planSessionStop({ ...press, streaming_message_ts: ["200.2", "", "  "] });
    expect(plan.kind === "stop" && plan.streams).toEqual(["200.2"]);
  });

  test("a payload missing what it needs is ignored, and says which part", () => {
    for (const [field, event] of [
      ["channel", { ...press, channel: undefined }],
      ["thread_ts", { ...press, thread_ts: undefined }],
      ["user", { ...press, user: undefined }],
    ] as const) {
      const plan = planSessionStop(event);
      expect(plan.kind).toBe("ignored");
      expect(plan.kind === "ignored" && plan.why).toContain(field);
    }
  });

  test("blank strings count as missing", () => {
    expect(planSessionStop({ ...press, channel: "   " }).kind).toBe("ignored");
  });
});

describe("sessionThreadKey", () => {
  test("it is the key the run registry is already keyed by", () => {
    // `respond` builds this for every turn it tracks. If the two ever differ,
    // Slack's stop button finds nothing and only the spinner says so - which
    // is why both call this one function.
    expect(sessionThreadKey("C123", "100.1")).toBe("C123:100.1");
  });

  test("a session started on a top-level message keys on that message's ts", () => {
    // respond uses `threadTs ?? messageTs`, and for a top-level session Slack
    // sends that same ts as thread_ts
    expect(sessionThreadKey("C1", "55.5")).toBe(sessionThreadKey("C1", "55.5"));
  });
});

describe("sessionStoppedLog", () => {
  const run = { what: "summarise the thread", startedAt: 1_000, actor: "U9" };
  const where = { by: "U9", channel: "C123", threadTs: "100.1" };

  test("it says who stopped what, in which thread, and how long it had been going", () => {
    const text = sessionStoppedLog(run, { ...where, link: "https://x.slack.com/archives/C123/p1001" }, 61_000, forHowLong);
    expect(text).toContain("<@U9> pressed stop");
    expect(text).toContain("<https://x.slack.com/archives/C123/p1001|thread>");
    expect(text).toContain("summarise the thread");
    expect(text).toContain("1m");
  });

  test("without a permalink it names the channel and the thread ts", () => {
    const text = sessionStoppedLog(run, where, 61_000, forHowLong);
    expect(text).toContain("<#C123>");
    expect(text).toContain("100.1");
  });

  test("stopping somebody else's turn names whose it was", () => {
    // Slack draws this button for anyone who can see the session, so the press
    // is honoured rather than refused - and the log says whose work it cut
    const text = sessionStoppedLog(run, { ...where, by: "U2" }, 61_000, forHowLong);
    expect(text).toContain("<@U2> pressed stop");
    expect(text).toContain("(<@U9>'s)");
  });

  test("stopping your own does not name you twice", () => {
    expect(sessionStoppedLog(run, where, 61_000, forHowLong)).not.toContain("(<@U9>'s)");
  });
});
