import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbClient } from "../../src/infrastructure/db/client.ts";
import { createSelfIssueRepo, type SelfIssueRepo } from "../../src/infrastructure/db/selfIssueRepo.ts";
import { createTurnLogRepo, type TurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createInnerChild, type DriftDeps, type InnerChildDeps } from "../../src/application/innerChild.ts";
import { createDriftRepo, type DriftRepo } from "../../src/infrastructure/db/driftRepo.ts";
import { driftNudge } from "../../src/domain/voiceDrift.ts";
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

describe("inner child: voice drift", () => {
  let events: DriftRepo;
  let steers: { channelId: string; threadTs: string; slackUserId: string; text: string }[];
  let steerReply: () => Promise<{ text: string; ts?: string }>;
  let activity: { event: string; data: Record<string, unknown> }[];
  let slackThread: { ts: string; own: boolean; text: string }[];

  beforeEach(() => {
    events = createDriftRepo(db);
    steers = [];
    steerReply = async () => ({ text: "the date was wrong, it is tuesday", ts: "9.9" });
    activity = [];
    slackThread = [];
  });

  const drift = (over: Partial<DriftDeps> = {}): DriftDeps => ({
    events,
    logChannel: () => "CLOG",
    replies: async () => slackThread,
    steer: async (r) => {
      steers.push(r);
      return steerReply();
    },
    activity: (event, data) => void activity.push({ event, data }),
    ...over,
  });

  /** A finished chat turn in C9/5.5 whose stored reply is `content`. */
  const drifted = (content: string, over: Partial<Parameters<TurnLogRepo["add"]>[0]> = {}) => {
    const channelId = over.channelId ?? "C9";
    const threadTs = over.threadTs ?? "5.5";
    const endedAt = over.endedAt ?? now;
    createMessageRepo(db).append(
      { channelId, slackUserId: "BOT", role: "assistant", content, threadTs },
      endedAt - 1,
    );
    addTurn({ outcome: "ok", error: "", request: "when is the release", startedAt: endedAt - 10, endedAt, ...over });
  };

  test("a capital start is steered in its thread as that person, logged, never posted there", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    slackThread = [{ ts: `${(now - 5) / 1000}`, own: true, text: "The release is on monday" }];
    await build({ drift: drift() }).tick();
    await settle();

    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatchObject({ channelId: "C9", threadTs: "5.5", slackUserId: "U1" });
    expect(steers[0]?.text).toContain('"The release is on monday"');
    // Nothing the inner child posted went to the drifted thread.
    expect(posts.every((p) => p.channel === "CLOG")).toBe(true);
    expect(posts[0]?.text).toContain("drift #1");
    expect(posts[0]?.text).toContain(steers[0]?.text ?? "missing");
    expect(posts[0]?.text).toContain(`p${String((now - 5) / 1000).replace(".", "")}`);
    // The follow-up lands in the log message's thread with a link to the correction.
    expect(posts[1]?.thread).toBe(posts[0] ? "1.0" : "");
    expect(posts[1]?.text).toContain("correction");
    expect(posts[1]?.text).toContain("p99");

    const row = events.get(1);
    expect(row).toMatchObject({
      channelId: "C9",
      threadTs: "5.5",
      rules: "capital",
      excerpt: "The release is on monday",
      logChannel: "CLOG",
      logTs: "1.0",
      outcome: "corrected",
      followUpText: "the date was wrong, it is tuesday",
      followUpTs: "9.9",
    });
    expect(row?.nudge).toBe(steers[0]?.text ?? "");
    expect(activity.map((a) => a.event)).toEqual(["inner_child_drift", "inner_child_drift_followup"]);
  });

  test("drift is never filed as a self-fix issue", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    await build({ drift: drift() }).tick();
    await settle();
    expect(issues.nextQueued()).toBeUndefined();
    expect(fixes).toHaveLength(0);
  });

  test("a clean reply is not steered", async () => {
    cursor = now - 100;
    drifted("the release is on monday");
    await build({ drift: drift() }).tick();
    await settle();
    expect(steers).toHaveLength(0);
    expect(events.steering()).toHaveLength(0);
  });

  test("a silence answer is logged as no change, an empty one as no reply", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    steerReply = async () => ({ text: "nothing to add" });
    await build({ drift: drift() }).tick();
    await settle();
    expect(events.get(1)?.outcome).toBe("no_change");
    expect(posts.at(-1)?.text).toContain("no change needed");

    now += 2000;
    drifted("Another one", { threadTs: "6.6" });
    steerReply = async () => ({ text: "" });
    const child = build({ drift: drift() });
    await child.tick();
    await settle();
    expect(events.get(2)?.outcome).toBe("no_reply");
  });

  test("a steer that throws is settled failed and said so in the log thread", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    steerReply = async () => {
      throw new Error("boom");
    };
    await build({ drift: drift() }).tick();
    await settle();
    expect(events.get(1)?.outcome).toBe("failed");
    expect(posts.at(-1)?.text).toContain("boom");
  });

  test("the same drifted reply is nudged once, even if it is seen again", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    slackThread = [{ ts: `${(now - 5) / 1000}`, own: true, text: "The release is on monday" }];
    await build({ drift: drift() }).tick();
    await settle();
    // Read again (a cursor reset): same channel + reply ts, so no second nudge.
    cursor = now - 100;
    await build({ drift: drift() }).tick();
    await settle();
    expect(steers).toHaveLength(1);
  });

  test("one nudge per thread per batch, for its newest drifted reply", async () => {
    cursor = now - 1000;
    drifted("The old one", { startedAt: now - 900, endedAt: now - 800 });
    drifted("The new one");
    await build({ drift: drift() }).tick();
    await settle();
    expect(steers).toHaveLength(1);
    expect(steers[0]?.text).toContain("The new one");
  });

  test("a thread with a nudge still open is not nudged again", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    steerReply = () => new Promise(() => {});
    const child = build({ drift: drift() });
    await child.tick();
    now += 2000;
    drifted("Another slip");
    await child.tick();
    expect(steers).toHaveLength(1);
  });

  test("the daily cap holds", async () => {
    cursor = now - 100;
    drifted("One", { threadTs: "1.1" });
    drifted("Two", { threadTs: "2.2" });
    drifted("Three", { threadTs: "3.3" });
    await build({ drift: drift({ maxPerDay: 2 }) }).tick();
    await settle();
    expect(steers).toHaveLength(2);
  });

  test("never steers itself: its own channel, the log channel, its fix threads, or a nudge's reply", async () => {
    cursor = now - 100;
    drifted("Own channel", { channelId: "CFIX", threadTs: "1.0" });
    drifted("Log channel", { channelId: "CLOG", threadTs: "2.0" });
    issues.file({ ...finding({ fingerprint: "f" }), severity: "bug" }, now);
    issues.startFix(1, "CX", "3.0", now);
    drifted("Fix thread", { channelId: "CX", threadTs: "3.0" });
    drifted("Still Capital after the nudge", { request: driftNudge([{ rule: "capital", excerpt: "x" }]) });
    await build({ drift: drift() }).tick();
    await settle();
    expect(steers).toHaveLength(0);
  });

  test("failed turns and non-chat turns are not judged for drift", async () => {
    cursor = now - 100;
    drifted("The error", { outcome: "failed", threadTs: "1.1" });
    drifted("The workflow step", { kind: "workflow", threadTs: "2.2" });
    await build({ drift: drift() }).tick();
    await settle();
    expect(steers).toHaveLength(0);
  });

  test("a language mismatch from the triage is steered, other turns' numbers are checked", async () => {
    cursor = now - 100;
    drifted("the release is on monday");
    triageAnswer = JSON.stringify([
      { drift: "language", turn: 1, excerpt: "the release" },
      { drift: "language", turn: 7, excerpt: "no such turn" },
    ]);
    await build({ drift: drift() }).tick();
    await settle();
    expect(steers).toHaveLength(1);
    expect(steers[0]?.text).toContain("different language");
    expect(events.get(1)?.rules).toBe("language");
    expect(String(triages[0]?.system)).toContain('"drift":"language"');
  });

  test("the cheap checks still steer when the triage model fails", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    const child = build({
      drift: drift(),
      llm: {
        complete: async () => {
          throw new Error("model down");
        },
      },
    });
    await child.tick();
    await settle();
    expect(steers).toHaveLength(1);
  });

  test("no log channel means no drift steering", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    await build({ drift: drift({ logChannel: () => "" }) }).tick();
    await settle();
    expect(steers).toHaveLength(0);
    expect(events.steering()).toHaveLength(0);
  });

  test("a log message that does not post means no nudge", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    await build({ drift: drift(), post: async () => undefined }).tick();
    await settle();
    expect(steers).toHaveLength(0);
    expect(events.get(1)?.outcome).toBe("failed");
  });

  test("the off switch covers drift too", async () => {
    cursor = now - 100;
    drifted("The release is on monday");
    await build({ drift: drift(), enabled: () => false }).tick();
    expect(steers).toHaveLength(0);
  });

  test("a nudge left open by a previous process is closed on boot, in its log thread", async () => {
    const e = events.record(
      { channelId: "C9", threadTs: "5.5", replyKey: "C9:m1", replyTs: "", rules: "capital", excerpt: "X", nudge: "n" },
      now,
    );
    events.setLog(e?.id ?? 0, "CLOG", "4.0");
    cursor = now;
    await build({ drift: drift() }).tick();
    expect(events.get(1)?.outcome).toBe("no_reply");
    expect(posts[0]).toMatchObject({ channel: "CLOG", thread: "4.0" });
    expect(posts[0]?.text).toContain("no reply");
  });
});
