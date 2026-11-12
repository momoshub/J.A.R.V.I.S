import { describe, expect, test } from "bun:test";
import { createGateModel } from "../../src/application/followGateModel.ts";
import type { LlmCompleteParams } from "../../src/application/ports.ts";

const q = {
  channel: "C1",
  threadTs: "9.9",
  actor: "U0PAL0001",
  context: [{ author: "Ann", text: "the deploy is red" }],
  batch: [{ author: "Bob", text: "same here" }],
};

describe("createGateModel", () => {
  test("asks on the policy it is given (pal model, no tools) and bills the newest author", async () => {
    let seen: LlmCompleteParams | undefined;
    const ask = createGateModel({
      llm: {
        complete: async (p) => {
          seen = p;
          return '{"verdict":"skip","reason":"chatting"}';
        },
      },
      policy: () => ({ skipPermissions: false, model: "haiku", disallowedTools: ["Bash"], timeoutMs: 20_000 }),
      botName: () => "Jarvis",
    });
    expect(await ask(q)).toEqual({ verdict: "skip", reason: "chatting" });
    expect(seen?.policy).toMatchObject({ skipPermissions: false, model: "haiku", timeoutMs: 20_000 });
    expect(seen?.bill).toMatchObject({ actor: "U0PAL0001", kind: "follow-gate", channel: "C1", threadTs: "9.9" });
    expect(seen?.system).toContain("Jarvis");
    expect(seen?.messages).toHaveLength(1);
    expect(seen?.messages[0]?.content).toContain("Bob: same here");
    expect(seen?.messages[0]?.content).toContain("Ann: the deploy is red");
    // a one-shot call: no durable session
    expect(seen?.session).toBeUndefined();
  });

  test("an unreadable answer is a reply, never a silent skip", async () => {
    const ask = createGateModel({
      llm: { complete: async () => "hmm, hard to say" },
      policy: () => ({ skipPermissions: false }),
      botName: () => "Jarvis",
    });
    expect((await ask(q)).verdict).toBe("reply");
  });

  test("a failed call throws, for the gate to fail open on", async () => {
    const ask = createGateModel({
      llm: {
        complete: async () => {
          throw new Error("cli exited 1");
        },
      },
      policy: () => ({ skipPermissions: false }),
      botName: () => "Jarvis",
    });
    await expect(ask(q)).rejects.toThrow("cli exited 1");
  });
});
