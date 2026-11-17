import { describe, expect, test } from "bun:test";
import { dispatchCommand } from "../../src/application/commands.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import { OWNER, db, actor, slackCalls, build } from "./commandsFixture.ts";

const LINK = "https://team.slack.com/archives/C0TEST00001/p1787122692303399";
const HERE = { threadTs: "1700000000.000001" };

const withBriefs = () => {
  const deps = build();
  const briefs = createThreadBriefRepo(db);
  deps.briefs = briefs;
  return { deps, briefs };
};

describe("post command", () => {
  test("posts top level in a channel id and files a brief under the new message", async () => {
    const { deps, briefs } = withBriefs();
    const base = deps.slack!;
    deps.slack = { ...base, post: async (channel, text, threadTs) => (slackCalls.posts.push({ channel, text, threadTs }), { channel, ts: "1800000000.000100" }) };
    const out = await dispatchCommand(deps, actor(), "D0SRC", "post C0TEST00002 Can infra send me the key?", HERE);
    expect(out).toContain("posted");
    expect(slackCalls.posts).toEqual([{ channel: "C0TEST00002", text: "Can infra send me the key?", threadTs: undefined }]);
    const unread = briefs.unread("C0TEST00002", "1800000000.000100", "sandbox");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({ fromChannel: "D0SRC", fromThread: HERE.threadTs, author: OWNER });
  });

  test("the footer never names the requester: `by` is undefined even when the actor has a display name", async () => {
    const deps = build();
    const bys: (string | undefined)[] = [];
    deps.slack = { ...deps.slack!, post: async (channel, _text, _threadTs, by) => (bys.push(by), { channel, ts: "1800000000.000100" }) };
    await dispatchCommand(deps, actor({ displayName: "Kai" }), "D0SRC", "post C0TEST00002 hi", HERE);
    expect(bys).toEqual([undefined]);
  });

  test("a thread link posts into that thread and briefs it", async () => {
    const { deps, briefs } = withBriefs();
    const out = await dispatchCommand(deps, actor(), "D0SRC", `post <${LINK}?thread_ts=1787000000.000100&cid=C0TEST00001> hello there`, HERE);
    expect(out).toContain("in that thread");
    expect(slackCalls.posts).toEqual([{ channel: "C0TEST00001", text: "hello there", threadTs: "1787000000.000100" }]);
    expect(briefs.unread("C0TEST00001", "1787000000.000100", "sandbox")).toHaveLength(1);
  });

  test("a channel mention works, and the text keeps its line breaks", async () => {
    const deps = build();
    await dispatchCommand(deps, actor(), "D0SRC", "post <#C0TEST00002|infra> line one\nline two", HERE);
    expect(slackCalls.posts).toEqual([{ channel: "C0TEST00002", text: "line one\nline two", threadTs: undefined }]);
  });

  test("a #name is looked up in the channel list", async () => {
    const deps = build();
    const pages: (string | undefined)[] = [];
    deps.slack = {
      ...deps.slack!,
      listConversationPage: async (_what, cursor) => {
        pages.push(cursor);
        return cursor
          ? { conversations: [{ id: "C0TEST00002", name: "infra", kind: "channel" }] }
          : { conversations: [{ id: "C0OTHER0001", name: "other", kind: "channel" }], nextCursor: "next" };
      },
    } as SlackAdminPort;
    expect(await dispatchCommand(deps, actor(), "D0SRC", "post #Infra hi", HERE)).toContain("posted");
    expect(pages).toEqual([undefined, "next"]);
    expect(slackCalls.posts[0]?.channel).toBe("C0TEST00002");
    expect(await dispatchCommand(deps, actor(), "D0SRC", "post #nope hi", HERE)).toContain("No channel named #nope");
  });

  test("only the owner: an admin is refused, naming the owner, and nothing is posted", async () => {
    const { deps, briefs } = withBriefs();
    const out = await dispatchCommand(deps, actor({ slackId: "U0ADMIN0001", role: "admin" }), "D0SRC", "post C0TEST00002 hi", HERE);
    expect(out).toContain("owner");
    expect(out).toContain("*admin*");
    expect(slackCalls.posts).toHaveLength(0);
    expect(briefs.unread("C0TEST00002", "1800000000.000100", "sandbox")).toHaveLength(0);
  });

  test("refuses a missing or unreadable target, empty text, and this very thread", async () => {
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "D0SRC", "post hello there", HERE)).toContain("Name where it goes");
    expect(await dispatchCommand(deps, actor(), "D0SRC", "post https://example.com/x hi", HERE)).toContain("Name where it goes");
    expect(await dispatchCommand(deps, actor(), "D0SRC", "post C0TEST00002", HERE)).toContain("what to post");
    expect(await dispatchCommand(deps, actor(), "C0TEST00001", `post ${LINK} hi`, { threadTs: "1787122692.303399" })).toContain("this thread");
    expect(slackCalls.posts).toHaveLength(0);
  });

  test("says so when the bot is not in the channel, and when no brief could be filed", async () => {
    const { deps } = withBriefs();
    deps.slack = { ...deps.slack!, post: async () => { throw new Error("not_in_channel"); } };
    expect(await dispatchCommand(deps, actor(), "D0SRC", "post C0TEST00002 hi", HERE)).toContain("not in that channel");
    // In a thread, but briefs are not wired: say that, not that Slack lost the message.
    const plain = build();
    const out = await dispatchCommand(plain, actor(), "D0SRC", "post C0TEST00002 hi", HERE);
    expect(out).toContain("no brief was filed (briefs are not available right now)");
    // Briefs wired, but the transport returned no ts for a top-level post.
    const { deps: wired } = withBriefs();
    expect(await dispatchCommand(wired, actor(), "D0SRC", "post C0TEST00002 hi", HERE)).toContain("no brief was filed (Slack did not say where it landed)");
    // Not in a thread at all.
    expect(await dispatchCommand(wired, actor(), "D0SRC", "post C0TEST00002 hi")).toContain("no brief was filed (no thread to file it from)");
  });

  test("is listed in help for the owner", async () => {
    const out = await dispatchCommand(build(), actor(), "D0SRC", "help");
    expect(out).toContain("post");
  });
});
