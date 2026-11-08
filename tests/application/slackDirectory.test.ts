import { describe, expect, test } from "bun:test";
import { createSlackDirectory, DIRECTORY_TTL_MS, type MemberPage } from "../../src/application/slackDirectory.ts";
import type { SlackMember } from "../../src/domain/slackMembers.ts";

const m = (id: string, realName: string, over: Partial<SlackMember> = {}): SlackMember => ({
  id, handle: realName.toLowerCase(), realName, displayName: "", title: "", email: "", avatar: "", deleted: false, isBot: false, ...over,
});

const pages: Record<string, MemberPage> = {
  "": { members: [m("U1", "Ann"), m("B1", "Annbot", { isBot: true })], nextCursor: "p2" },
  p2: { members: [m("U2", "Anders"), m("U3", "Annie", { deleted: true })] },
};

const setup = () => {
  let now = 0;
  const calls: (string | undefined)[] = [];
  let fail = false;
  const dir = createSlackDirectory({
    clock: () => now,
    listMembers: async (cursor) => {
      calls.push(cursor);
      if (fail) throw new Error("ratelimited");
      return pages[cursor ?? ""]!;
    },
  });
  return { dir, calls, tick: (ms: number) => (now += ms), failing: (f: boolean) => (fail = f) };
};

describe("slack directory", () => {
  test("reads every page, filters server-side, skips bots and deleted", async () => {
    const { dir, calls } = setup();
    expect((await dir.search("an", 10)).map((x) => x.id)).toEqual(["U2", "U1"]);
    expect(calls).toEqual([undefined, "p2"]);
  });

  test("caches for the ttl and shares a sweep in flight", async () => {
    const { dir, calls, tick } = setup();
    await Promise.all([dir.search("a", 5), dir.search("b", 5)]);
    expect(calls).toHaveLength(2);
    tick(DIRECTORY_TTL_MS - 1);
    await dir.search("ann", 5);
    expect(calls).toHaveLength(2);
    tick(1);
    await dir.search("ann", 5);
    expect(calls).toHaveLength(4);
  });

  test("a blank query costs no call", async () => {
    const { dir, calls } = setup();
    expect(await dir.search("   ", 5)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a failed refresh keeps the last good list; a first failure throws", async () => {
    const { dir, tick, failing } = setup();
    failing(true);
    await expect(dir.search("ann", 5)).rejects.toThrow("ratelimited");
    failing(false);
    expect(await dir.search("ann", 5)).toHaveLength(1);
    failing(true);
    tick(DIRECTORY_TTL_MS);
    expect((await dir.search("ann", 5)).map((x) => x.id)).toEqual(["U1"]);
  });
});
