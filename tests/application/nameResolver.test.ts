import { describe, expect, test } from "bun:test";
import { createNameResolver, type NameLookups } from "../../src/application/nameResolver.ts";
import type { ConversationInfo } from "../../src/domain/slackNames.ts";

const fake = (convos: Record<string, ConversationInfo>, people: Record<string, string>) => {
  const calls = { conversation: [] as string[], users: [] as string[][] };
  const lookups: NameLookups = {
    conversation: async (id) => {
      calls.conversation.push(id);
      return convos[id];
    },
    users: async (ids) => {
      calls.users.push([...ids]);
      return Object.fromEntries(ids.map((id) => [id, people[id] ?? id]));
    },
  };
  return { calls, lookups };
};

describe("name resolver", () => {
  test("labels channels and DMs, and asks Slack once per id however often a page renders", async () => {
    let now = 0;
    const { calls, lookups } = fake({ C1: { kind: "channel", name: "ops" }, D1: { kind: "im", userId: "U1" } }, { U1: "Kai" });
    const names = createNameResolver({ lookups, clock: () => now, ttlMs: 1000, failTtlMs: 100 });
    expect(await names.conversationLabels(["C1", "D1", "C1"])).toEqual({ C1: "#ops (C1)", D1: "@Kai (D1)" });
    await names.conversationLabels(["C1", "D1"]);
    expect(calls.conversation).toEqual(["C1", "D1"]);
    expect(calls.users).toEqual([["U1"]]);
    now = 1001;
    await names.conversationLabels(["C1"]);
    expect(calls.conversation).toEqual(["C1", "D1", "C1"]);
  });

  test("a failure is cached for the shorter time, then asked again", async () => {
    let now = 0;
    const { calls, lookups } = fake({}, {});
    const names = createNameResolver({ lookups, clock: () => now, ttlMs: 1000, failTtlMs: 100 });
    expect(await names.conversationLabels(["C9"])).toEqual({ C9: "unknown (C9)" });
    expect(await names.userLabels(["U9"])).toEqual({ U9: "unknown (U9)" });
    await names.conversationLabels(["C9"]);
    await names.userLabels(["U9"]);
    expect(calls.conversation).toEqual(["C9"]);
    expect(calls.users).toEqual([["U9"]]);
    now = 101;
    await names.conversationLabels(["C9"]);
    await names.userLabels(["U9"]);
    expect(calls.conversation).toEqual(["C9", "C9"]);
    expect(calls.users).toEqual([["U9"], ["U9"]]);
  });

  test("concurrent lookups of one conversation share a single call", async () => {
    const { calls, lookups } = fake({ C1: { kind: "channel", name: "ops" } }, {});
    const names = createNameResolver({ lookups, clock: () => 0 });
    await Promise.all([names.conversationLabels(["C1"]), names.conversationLabels(["C1"])]);
    expect(calls.conversation).toEqual(["C1"]);
  });

  test("a name stored on the allowlist wins and costs no call; a throwing lookup means unknown", async () => {
    const { calls, lookups } = fake({}, { U1: "Slack Kai" });
    const names = createNameResolver({ lookups, clock: () => 0, knownName: (id) => (id === "U1" ? "Kai" : undefined) });
    expect(await names.userLabels(["U1"])).toEqual({ U1: "Kai (U1)" });
    expect(calls.users).toEqual([]);
    const broken = createNameResolver({
      clock: () => 0,
      lookups: { conversation: () => Promise.reject(new Error("x")), users: () => Promise.reject(new Error("x")) },
    });
    expect(await broken.userLabels(["U2"])).toEqual({ U2: "unknown (U2)" });
    expect(await broken.conversationLabels(["C2"])).toEqual({ C2: "unknown (C2)" });
    // No Slack at all: still name + id, never a bare id.
    expect(await createNameResolver({ clock: () => 0 }).userLabels(["U3"])).toEqual({ U3: "unknown (U3)" });
  });

  test("a cold render never has more than the cap of conversation lookups in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const names = createNameResolver({
      clock: () => 0,
      concurrency: 3,
      lookups: {
        conversation: async (id) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight -= 1;
          return { kind: "channel", name: id.toLowerCase() };
        },
        users: async () => ({}),
      },
    });
    const ids = Array.from({ length: 10 }, (_, i) => `C${i}`);
    const labels = await names.conversationLabels(ids);
    expect(Object.keys(labels)).toHaveLength(10);
    expect(labels.C7).toBe("#c7 (C7)");
    expect(peak).toBe(3);
  });
});
