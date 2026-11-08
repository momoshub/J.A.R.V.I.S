import { describe, expect, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { createSlackAdmin } from "../../src/infrastructure/slack/adminClient.ts";
import { FOOTER_BLOCK_ID, footerLine } from "../../src/domain/messageFooter.ts";

const NOW = 1_794_123_692_000;

type Call = [string, Record<string, unknown>];
type Block = { type: string; block_id?: string; elements?: { text?: string }[] };

/** A WebClient that records chat calls; `refuse` makes a post with blocks fail. */
const fake = (refuse?: (a: Record<string, unknown>) => boolean) => {
  const calls: Call[] = [];
  const client = {
    conversations: { open: async () => ({ channel: { id: "D9" } }) },
    chat: {
      postMessage: async (a: Record<string, unknown>) => {
        calls.push(["post", a]);
        if (refuse?.(a)) throw new Error("invalid_blocks");
        return { ts: `${calls.length}.0` };
      },
      update: async (a: Record<string, unknown>) => void calls.push(["update", a]),
    },
  } as unknown as WebClient;
  return { calls, admin: createSlackAdmin(client, () => NOW) };
};

const footerOf = (a: Record<string, unknown> | undefined): Block | undefined => (a?.blocks as Block[] | undefined)?.at(-1);
const signedBy = (a: Record<string, unknown> | undefined): string | undefined => footerOf(a)?.elements?.[0]?.text;

describe("every message the admin client writes is signed", () => {
  test("a plain post is sections plus a footer signed Jarvis, stamped now", async () => {
    const { calls, admin } = fake();
    await admin.post("C1", "hello **there**", "100.1");
    const [, a] = calls[0]!;
    expect(a).toMatchObject({ channel: "C1", thread_ts: "100.1", text: "hello *there*" });
    expect((a.blocks as Block[])[0]).toMatchObject({ type: "section" });
    expect(footerOf(a)).toMatchObject({ type: "context", block_id: FOOTER_BLOCK_ID });
    expect(signedBy(a)).toBe(footerLine("Jarvis", NOW));
  });

  test("the poster names itself", async () => {
    const { calls, admin } = fake();
    await admin.post("C1", "⏰ reminder", undefined, "reminder");
    await admin.postDm("U1", "hi", "inner child Jarvis");
    expect(signedBy(calls[0]?.[1])).toStartWith("reminder · updated ");
    expect(signedBy(calls[1]?.[1])).toStartWith("inner child Jarvis · updated ");
  });

  test("a Block Kit post keeps its blocks and gains the footer", async () => {
    const { calls, admin } = fake();
    await admin.post("C1", 'look\n```blockkit\n[{"type":"divider"}]\n```', undefined, "watch");
    const blocks = calls[0]?.[1].blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["markdown", "divider", "context"]);
    expect(signedBy(calls[0]?.[1])).toStartWith("watch · ");
  });

  test("blocks Slack refuses still get the words out, signed if it can and bare if not", async () => {
    const { calls, admin } = fake((a) => Array.isArray(a.blocks));
    const ref = await admin.post("C1", "still here", "100.1");
    expect(calls.map(([, a]) => Array.isArray(a.blocks))).toEqual([true, false]);
    expect(calls[1]?.[1]).toEqual({ channel: "C1", text: "still here", thread_ts: "100.1" });
    expect(ref).toEqual({ channel: "C1", ts: "2.0" });
  });

  test("an edit sends blocks, so the old ones never stay on screen, and is restamped", async () => {
    const { calls, admin } = fake();
    await admin.update("C1", "5.5", "draining: 2 turns left");
    await admin.settleInteractive("C1", "6.6", "approved by <@U1>", "command");
    expect(calls[0]?.[0]).toBe("update");
    expect(calls[0]?.[1]).toMatchObject({ channel: "C1", ts: "5.5", text: "draining: 2 turns left" });
    expect(signedBy(calls[0]?.[1])).toBe(footerLine("Jarvis", NOW));
    expect((calls[1]?.[1].blocks as Block[]).map((b) => b.type)).toEqual(["section", "context"]);
    expect(signedBy(calls[1]?.[1])).toStartWith("command · ");
  });

  test("a refused rewrite still edits the words, text-only", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      chat: {
        update: async (a: Record<string, unknown>) => {
          calls.push(a);
          if (a.blocks) throw new Error("block_mismatch");
        },
      },
    } as unknown as WebClient;
    await createSlackAdmin(client, () => NOW).update("C1", "5.5", "edited");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ channel: "C1", ts: "5.5", text: "edited" });
  });

  test("a refused settle still drops the buttons, unsigned, then falls back to text-only", async () => {
    const calls: Record<string, unknown>[] = [];
    let refusals = 2;
    const client = {
      chat: {
        update: async (a: Record<string, unknown>) => {
          calls.push(a);
          if (refusals-- > 0) throw new Error("invalid_blocks");
        },
      },
    } as unknown as WebClient;
    await createSlackAdmin(client, () => NOW).settleInteractive("C1", "6.6", "approved");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({ channel: "C1", ts: "6.6", text: "approved", blocks: [{ type: "section", text: { type: "mrkdwn", text: "approved" } }] });
    expect(calls[2]).toEqual({ channel: "C1", ts: "6.6", text: "approved" });
  });

  test("a signed edit of one very long line keeps every section under Slack's 3000", async () => {
    const { calls, admin } = fake();
    await admin.update("C1", "5.5", "z".repeat(9000));
    const sections = (calls[0]?.[1].blocks as { type: string; text?: { text: string } }[]).filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(3);
    for (const s of sections) expect(s.text!.text.length).toBeLessThanOrEqual(3000);
  });

  test("buttons and menus carry the footer under their actions", async () => {
    const { calls, admin } = fake();
    const actions = [{ actionId: "a", label: "Yes", value: "y" }];
    await admin.postInteractive("C1", "ok?", actions, "100.1");
    await admin.postDmInteractive("U1", "ok?", actions);
    await admin.postMenu("C1", "pick", { actions });
    for (const [, a] of calls) {
      const types = (a.blocks as Block[]).map((b) => b.type);
      expect(types.slice(-2)).toEqual(["actions", "context"]);
      expect(signedBy(a)).toStartWith("Jarvis · updated ");
    }
  });
});
