import { describe, expect, test } from "bun:test";
import { dispatchCommand, isQuietCommand } from "../../src/application/commands.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";
import { OWNER, db, actor, slackCalls, build } from "./commandsFixture.ts";

const LINK = "https://team.slack.com/archives/C0TEST00001/p1787122692303399";
const HERE = { threadTs: "1700000000.000001" };

const withBriefs = () => {
  const deps = build();
  const briefs = createThreadBriefRepo(db);
  deps.briefs = briefs;
  return { deps, briefs };
};

describe("brief command", () => {
  test("files a brief for the linked thread, posts nothing and starts no turn", async () => {
    const { deps, briefs } = withBriefs();
    const turns: unknown[] = [];
    deps.runTurn = async (r) => void turns.push(r);
    const out = await dispatchCommand(deps, actor(), "D0SRC", `brief ${LINK} Posted the rollout plan, waiting for QA sign-off`, HERE);
    expect(out).toContain("filed");
    const unread = briefs.unread("C0TEST00001", "1787122692.303399", "sandbox");
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      fromChannel: "D0SRC",
      fromThread: HERE.threadTs,
      author: OWNER,
      text: "Posted the rollout plan, waiting for QA sign-off",
    });
    expect(turns).toHaveLength(0);
    expect(slackCalls.posts).toHaveLength(0);
  });

  test("uses thread_ts from the link when it points at a reply", async () => {
    const { deps, briefs } = withBriefs();
    await dispatchCommand(deps, actor(), "D0SRC", `brief ${LINK}?thread_ts=1787000000.000100&cid=C0TEST00001 note`, HERE);
    expect(briefs.unread("C0TEST00001", "1787000000.000100", "sandbox")).toHaveLength(1);
  });

  test("the target answers the source by the reference it was shown", async () => {
    const { deps, briefs } = withBriefs();
    await dispatchCommand(deps, actor(), "D0SRC", `brief ${LINK} from A`, HERE);
    const ref = briefs.ref("D0SRC", HERE.threadTs);
    const out = await dispatchCommand(deps, actor(), "C0TEST00001", `brief ${ref} QA passed`, { threadTs: "1787122692.303399" });
    expect(out).toContain("filed");
    expect(briefs.unread("D0SRC", HERE.threadTs, "sandbox").map((b) => b.text)).toEqual(["QA passed"]);
  });

  test("a reference from a thread that never wrote here is refused", async () => {
    const { deps, briefs } = withBriefs();
    const out = await dispatchCommand(deps, actor(), "C0TEST00001", "brief deadbeef00 hi", HERE);
    expect(out).toContain("No thread by that reference");
    expect(briefs.unread("D0SRC", HERE.threadTs, "sandbox")).toHaveLength(0);
  });

  test("refuses itself, an empty brief, a bad link, a too-long one, and use outside a thread", async () => {
    const { deps, briefs } = withBriefs();
    expect(await dispatchCommand(deps, actor(), "C0TEST00001", `brief ${LINK} hi`, { threadTs: "1787122692.303399" })).toContain("this thread");
    expect(await dispatchCommand(deps, actor(), "D0SRC", `brief ${LINK}`, HERE)).toContain("what is the brief");
    expect(await dispatchCommand(deps, actor(), "D0SRC", "brief not-a-link hi", HERE)).toContain("thread link");
    expect(await dispatchCommand(deps, actor(), "D0SRC", `brief ${LINK} ${"x".repeat(4001)}`, HERE)).toContain("at most 4000");
    expect(await dispatchCommand(deps, actor(), "D0SRC", `brief ${LINK} hi`)).toContain("inside a thread");
    expect(briefs.unread("C0TEST00001", "1787122692.303399", "sandbox")).toHaveLength(0);
  });

  test("help explains it without filing anything", async () => {
    const { deps, briefs } = withBriefs();
    for (const line of ["brief help", "brief"]) {
      const out = await dispatchCommand(deps, actor(), "D0SRC", line, HERE);
      expect(out).toContain("brief <thread-link|reference> <text>");
      expect(out).toContain("Posts nothing in Slack and starts no turn");
    }
    expect(briefs.unread("C0TEST00001", "1787122692.303399", "sandbox")).toHaveLength(0);
  });

  test("is gated like tell: admin and up, quiet", async () => {
    const { deps, briefs } = withBriefs();
    expect(isQuietCommand("brief")).toBe(true);
    for (const role of ["pal", "executer"] as const) {
      await dispatchCommand(deps, actor({ slackId: "U0TEST00002", role }), "D0SRC", `brief ${LINK} hi`, HERE);
    }
    expect(briefs.unread("C0TEST00001", "1787122692.303399", "sandbox")).toHaveLength(0);
    await dispatchCommand(deps, actor({ slackId: "U0TEST00003", role: "admin" }), "D0SRC", `brief ${LINK} hi`, HERE);
    expect(briefs.unread("C0TEST00001", "1787122692.303399", "sandbox")).toHaveLength(1);
  });
});
