import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import { createThreadQueue } from "../../src/application/threadQueue.ts";
import { createRunRegistry, RESTART_STOPPER } from "../../src/application/runRegistry.ts";
import { BRIEFS_OPEN, BRIEF_MAX_SHOWN } from "../../src/domain/threadBrief.ts";
import type { LlmPort } from "../../src/application/ports.ts";

const OWNER = "U0OWNER0001";
const SOURCE = { channel: "D0SRC", thread: "1.1" };
const TARGET = { channel: "C1", thread: "9.9" };

const setup = (llm: (system: string) => Promise<string>) => {
  const db = openDatabase(":memory:");
  let t = 1;
  const briefs = createThreadBriefRepo(db);
  const seen: string[] = [];
  const port: LlmPort = {
    complete: async (p) => {
      seen.push(p.system);
      return llm(p.system);
    },
  };
  const deps: RespondDeps = {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    llm: port,
    clock: () => t++,
    ownerSlackId: OWNER,
    contextWindow: 10,
    commandPrefix: "//jarvis",
    briefs,
  };
  const leave = (text: string, to = TARGET) =>
    briefs.add({ fromChannel: SOURCE.channel, fromThread: SOURCE.thread, toChannel: to.channel, toThread: to.thread, author: OWNER, text }, 1);
  return { deps, briefs, seen, leave };
};

const turn = (text = "any news?", over: Record<string, unknown> = {}) => ({
  channelId: TARGET.channel,
  slackUserId: OWNER,
  text,
  threadTs: TARGET.thread,
  messageTs: "9.10",
  viaSlash: false,
  ...over,
});

describe("briefs reach the next turn in the target thread", () => {
  test("any trigger sees them, as a delimited block with an opaque source", async () => {
    const { deps, seen, leave } = setup(async () => "ok");
    leave("Rolled out the fix to staging; waiting on QA before prod");
    await respond(deps, turn("hey, what is going on here?"));
    expect(seen[0]).toContain(BRIEFS_OPEN);
    expect(seen[0]).toContain("Rolled out the fix to staging; waiting on QA before prod");
    expect(seen[0]).toContain("//jarvis brief <reference> <text>");
    // the private source is never named
    expect(seen[0]).not.toContain(SOURCE.channel);
  });

  test("an unprompted turn (tell, a watch hand-back) gets them too", async () => {
    const { deps, seen, leave } = setup(async () => "ok");
    leave("context for you");
    await respond(deps, turn("[tell from another thread] carry on", { unprompted: true }));
    expect(seen[0]).toContain("context for you");
  });

  test("a thread with nothing unread gets no block, and other threads' briefs stay out", async () => {
    const { deps, seen, leave } = setup(async () => "ok");
    leave("not for you", { channel: "C2", thread: "5.5" });
    await respond(deps, turn());
    expect(seen[0]).not.toContain(BRIEFS_OPEN);
    expect(seen[0]).not.toContain("not for you");
  });

  test("a thread without briefs wired still answers", async () => {
    const { deps, seen } = setup(async () => "ok");
    const { briefs: _unused, ...bare } = deps;
    await respond(bare, turn());
    expect(seen).toHaveLength(1);
  });
});

describe("briefs are marked read only after the turn ran", () => {
  test("after a turn that worked, they are not handed over again", async () => {
    const { deps, briefs, seen, leave } = setup(async () => "ok");
    leave("once only");
    await respond(deps, turn());
    expect(briefs.unread(TARGET.channel, TARGET.thread)).toHaveLength(0);
    await respond(deps, turn("and now?", { messageTs: "9.11" }));
    expect(seen[0]).toContain("once only");
    expect(seen[1]).not.toContain("once only");
  });

  test("a turn that threw keeps them unread, so the retry sees them", async () => {
    let fail = true;
    const { deps, briefs, seen, leave } = setup(async () => {
      if (fail) throw new Error("disk I/O error");
      return "ok";
    });
    leave("still owed");
    await expect(respond(deps, turn())).rejects.toThrow("disk I/O error");
    expect(briefs.unread(TARGET.channel, TARGET.thread)).toHaveLength(1);
    fail = false;
    await respond(deps, turn("again", { messageTs: "9.11" }));
    expect(seen[1]).toContain("still owed");
    expect(briefs.unread(TARGET.channel, TARGET.thread)).toHaveLength(0);
  });

  test("a turn cut for a restart keeps them unread", async () => {
    const runs = createRunRegistry();
    const { deps, briefs, leave } = setup(async () => {
      const running = runs.current(`${TARGET.channel}:${TARGET.thread}`);
      runs.stop(running!.id, RESTART_STOPPER);
      return "half an ans";
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;
    leave("survives the cut");
    expect(await respond(deps, turn())).toEqual({ kind: "ignored" });
    expect(briefs.unread(TARGET.channel, TARGET.thread)).toHaveLength(1);
  });

  test("a brief that lands during the turn is not marked read by it", async () => {
    let late: (() => void) | undefined;
    const { deps, briefs, leave } = setup(async () => {
      late?.();
      return "ok";
    });
    leave("early");
    late = () => leave("late");
    await respond(deps, turn());
    expect(briefs.unread(TARGET.channel, TARGET.thread).map((b) => b.text)).toEqual(["late"]);
  });

  test("only the briefs shown are marked: older ones past the cap come next turn", async () => {
    const { deps, briefs, seen, leave } = setup(async () => "ok");
    for (let i = 1; i <= BRIEF_MAX_SHOWN + 1; i++) leave(`brief number ${i}`);
    await respond(deps, turn());
    expect(seen[0]).not.toContain("brief number 1\n");
    expect(seen[0]).toContain("(1 older unread brief not shown)");
    expect(briefs.unread(TARGET.channel, TARGET.thread).map((b) => b.text)).toEqual(["brief number 1"]);
  });
});
