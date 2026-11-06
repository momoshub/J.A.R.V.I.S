import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createSelfIssueRepo, type SelfIssueRepo } from "../../src/infrastructure/db/selfIssueRepo.ts";
import { createTurnLogRepo, type TurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createInnerChild, type InnerChildDeps } from "../../src/application/innerChild.ts";
import type { LlmCompleteParams } from "../../src/application/ports.ts";

let db: DbClient;
let issues: SelfIssueRepo;
let turns: TurnLogRepo;
let now: number;
let cursor: number | undefined;
let posts: { channel: string; text: string; thread?: string }[];
let fixes: { threadTs: string; text: string; slackUserId: string }[];
let triages: LlmCompleteParams[];
let triageAnswer: string;
let fixReply: () => Promise<string>;

const finding = (over: Record<string, unknown> = {}) => ({
  fingerprint: "broken-cmd",
  title: "bomb command crashes",
  severity: "bug",
  channelId: "C9",
  threadTs: "5.5",
  evidence: "TypeError",
  hint: "",
  ...over,
});

const build = (over: Partial<InnerChildDeps> = {}) =>
  createInnerChild({
    turns,
    messages: createMessageRepo(db),
    issues,
    llm: {
      complete: async (p) => {
        triages.push(p);
        return triageAnswer;
      },
    },
    clock: () => now,
    channelId: "CFIX",
    ownerSlackId: "UOWNER",
    botName: () => "Bot",
    sourceDir: "/src",
    restartScript: "/src/bin/restart.sh",
    noTools: ["Bash"],
    enabled: () => true,
    cursor: { get: () => cursor, set: (at) => void (cursor = at) },
    post: async (channel, text, thread) => {
      posts.push({ channel, text, thread });
      return { ts: `${posts.length}.0` };
    },
    runFix: async (r) => {
      fixes.push({ threadTs: r.threadTs, text: r.text, slackUserId: r.slackUserId });
      return fixReply();
    },
    triageEveryMs: 1000,
    ...over,
  });

const addTurn = (over: Partial<Parameters<TurnLogRepo["add"]>[0]> = {}) =>
  turns.add({
    runId: "r",
    channelId: "C9",
    threadTs: "5.5",
    slackUserId: "U1",
    kind: "chat",
    request: "bomb that",
    outcome: "failed",
    error: "TypeError",
    startedAt: now - 10,
    endedAt: now,
    ...over,
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = openDatabase(":memory:");
  issues = createSelfIssueRepo(db);
  turns = createTurnLogRepo(db);
  now = 1_000_000;
  cursor = undefined;
  posts = [];
  fixes = [];
  triages = [];
  triageAnswer = "[]";
  fixReply = async () => "changed x\nRESULT: fixed";
});

describe("inner child", () => {
  test("the first look only sets the cursor, so history is never filed as new", async () => {
    addTurn();
    await build().tick();
    expect(cursor).toBe(now);
    expect(triages).toHaveLength(0);
  });

  test("a quiet period costs no model run", async () => {
    cursor = now - 100;
    await build().tick();
    expect(triages).toHaveLength(0);
  });

  test("a defect is announced, fixed as the owner in that thread, and reported after", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding()]);
    await build().tick();
    await settle();

    expect(triages).toHaveLength(1);
    expect(triages[0]?.policy?.disallowedTools).toEqual(["Bash"]);
    expect(posts[0]?.channel).toBe("CFIX");
    expect(posts[0]?.thread).toBeUndefined();
    expect(posts[0]?.text).toContain("bomb command crashes");
    expect(fixes).toEqual([expect.objectContaining({ threadTs: "1.0", slackUserId: "UOWNER" })]);
    expect(posts[1]?.thread).toBe("1.0");
    expect(posts[1]?.text).toContain("fixed");
    expect(issues.get(1)?.state).toBe("fixed");
  });

  test("each turn is triaged with its own reply, not a later turn's in the same thread", async () => {
    cursor = now - 1000;
    const messages = createMessageRepo(db);
    const reply = (content: string, at: number) =>
      messages.append({ channelId: "C9", slackUserId: "BOT", role: "assistant", content, threadTs: "5.5" }, at);
    addTurn({ request: "first question", outcome: "ok", error: "", startedAt: now - 900, endedAt: now - 500 });
    reply("answer to the first", now - 600);
    addTurn({ request: "second question", outcome: "ok", error: "", startedAt: now - 400, endedAt: now });
    reply("answer to the second", now - 100);
    await build({ messages }).tick();

    const sent = String(triages[0]?.messages[0]?.content);
    const first = sent.slice(sent.indexOf("first question"), sent.indexOf("second question"));
    expect(first).toContain("answer to the first");
    expect(first).not.toContain("answer to the second");
    expect(sent.slice(sent.indexOf("second question"))).toContain("answer to the second");
  });

  test("the same defect is never filed twice", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding()]);
    const child = build();
    await child.tick();
    await settle();
    now += 2000;
    addTurn({ endedAt: now });
    await child.tick();
    await settle();
    expect(fixes).toHaveLength(1);
  });

  test("one fix at a time: a second finding waits for the first", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding(), finding({ fingerprint: "other" })]);
    let release: (v: string) => void = () => {};
    fixReply = () => new Promise((r) => (release = r));
    const child = build();
    await child.tick();
    expect(fixes).toHaveLength(1);
    await child.tick();
    expect(fixes).toHaveLength(1);
    release("RESULT: not fixed");
    await settle();
    expect(issues.get(1)?.state).toBe("not_fixed");
    fixReply = async () => "RESULT: fixed";
    await child.tick();
    await settle();
    expect(fixes).toHaveLength(2);
  });

  test("the daily cap holds", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding(), finding({ fingerprint: "b" })]);
    const child = build({ maxFixesPerDay: 1 });
    await child.tick();
    await settle();
    await child.tick();
    await settle();
    expect(fixes).toHaveLength(1);
    expect(issues.nextQueued()?.fingerprint).toBe("b");
  });

  test("its own fix threads are never triaged", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding()]);
    const child = build();
    await child.tick();
    await settle();
    triages = [];
    now += 2000;
    addTurn({ channelId: "CFIX", threadTs: "1.0", endedAt: now });
    await child.tick();
    expect(triages).toHaveLength(0);
  });

  test("a fix run that throws is settled failed and said so", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding()]);
    fixReply = async () => {
      throw new Error("boom");
    };
    await build().tick();
    await settle();
    expect(issues.get(1)?.state).toBe("failed");
    expect(posts.at(-1)?.text).toContain("boom");
  });

  test("a fix left running by a previous process is written off on boot", async () => {
    issues.file({ ...finding(), severity: "bug" }, now);
    issues.startFix(1, "CFIX", "7.0", now);
    cursor = now;
    await build().tick();
    expect(issues.get(1)?.state).toBe("failed");
    expect(posts[0]?.text).toContain("restart");
  });

  test("an unposted announcement leaves the issue queued", async () => {
    cursor = now - 100;
    addTurn();
    triageAnswer = JSON.stringify([finding()]);
    await build({ post: async () => undefined }).tick();
    expect(fixes).toHaveLength(0);
    expect(issues.get(1)?.state).toBe("queued");
  });

  test("off means off", async () => {
    cursor = now - 100;
    addTurn();
    await build({ enabled: () => false }).tick();
    expect(triages).toHaveLength(0);
  });
});
