import { describe, expect, test } from "bun:test";
import type { InternalKind } from "../../src/domain/internalMessages.ts";
import type { HandleResult, InboundMessage } from "../../src/application/handleMessage.ts";
import { createTurnRunner } from "../../src/application/turnRunner.ts";

type Posted = { channel: string; text: string; threadTs?: string; by?: string; trigger?: InternalKind };

const make = (result: HandleResult) => {
  const posted: Posted[] = [];
  const inbounds: InboundMessage[] = [];
  const runTurn = createTurnRunner({
    // Echoes the trigger the sender named, as `respond` -> `handleMessage` does.
    respond: async (inbound) => {
      inbounds.push(inbound);
      return result.kind === "reply" && inbound.trigger ? { ...result, trigger: inbound.trigger } : result;
    },
    post: async (channel, text, threadTs, by, _usage, trigger) => {
      posted.push({ channel, text, threadTs, by, trigger });
    },
    clock: () => 1_000,
    loopModel: () => "sonnet",
  });
  return { runTurn, posted, inbounds };
};

const req = { channelId: "C1", threadTs: "1.1", slackUserId: "U1" };

describe("createTurnRunner", () => {
  test("the trigger a sender names reaches respond, and the reply is posted with it", async () => {
    for (const trigger of ["watch", "tell", "nudge", "orca"] as const) {
      const { runTurn, posted, inbounds } = make({ kind: "reply", text: "done", by: "Jarvis" });
      await runTurn({ ...req, text: "x", unprompted: true, trigger });
      expect(inbounds[0]?.trigger).toBe(trigger);
      expect(posted).toEqual([{ channel: "C1", text: "done", threadTs: "1.1", by: "Jarvis", trigger }]);
    }
  });

  test("a turn whose sender names no trigger posts none, whatever its text looks like", async () => {
    const { runTurn, posted } = make({ kind: "reply", text: "done" });
    await runTurn({ ...req, text: "[loop 3] every 5m: check the queue" });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.trigger).toBeUndefined();
  });

  test("a held loop fire hands its reply back to the loop runner instead of posting, on the loop model", async () => {
    const { runTurn, posted, inbounds } = make({ kind: "reply", text: "found 3" });
    expect(await runTurn({ ...req, text: "x", loop: true, hold: true, trigger: "loop" })).toEqual({ text: "found 3" });
    expect(posted).toHaveLength(0);
    expect(inbounds[0]).toMatchObject({ model: "sonnet", trigger: "loop" });
  });

  test("a silence note or an ignored turn posts nothing", async () => {
    for (const result of [{ kind: "reply", text: "NO_REPLY" }, { kind: "ignored" }] as const) {
      const { runTurn, posted } = make(result);
      await runTurn({ ...req, text: "x", trigger: "watch" });
      expect(posted).toHaveLength(0);
    }
  });
});
