import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createWorkflowRepo } from "../../src/infrastructure/db/workflowRepo.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import { createThreadQueue } from "../../src/application/threadQueue.ts";
import { createRunRegistry } from "../../src/application/runRegistry.ts";
import { resumeContinues } from "../../src/application/workflowContinue.ts";
import { runWorkflowTurn } from "../../src/application/workflow.ts";
import { sessionThreadKey } from "../../src/domain/agentSession.ts";
import { AUTO_CONTINUE_CAP, CONTINUE_MESSAGE } from "../../src/domain/workflowContinue.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmCompleteParams, LlmPort, LlmStreamEvent } from "../../src/application/ports.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";

const OWNER = "U0OWNER";
const EXEC = "U0EXEC";
const SESSION = "11111111-2222-3333-4444-555555555555";
const C = "C1";
const T = "100.1";

const owner: AllowedUser = { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 0 };

type Reply = (p: LlmCompleteParams) => string;

/**
 * A bot with a thread queue, a run registry, a timer that only fires when the
 * test says so, and `runTurn` wired exactly as the composition root wires it:
 * through `respond`.
 */
const build = (reply: Reply) => {
  const db = openDatabase(":memory:");
  const calls: LlmCompleteParams[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const posts: { channel: string; text: string; thread?: string }[] = [];
  const llm: LlmPort = {
    complete: async (p) => {
      calls.push(p);
      return reply(p);
    },
  };
  const users = createUserRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  users.upsert({ slackId: EXEC, role: "executer", displayName: "Ex", addedBy: "system", createdAt: 1 });
  const slack = {
    post: async (channel: string, text: string, thread?: string) => {
      posts.push({ channel, text, thread });
      return { channel, ts: `${posts.length}.0` };
    },
    remove: async () => {},
  } as unknown as SlackAdminPort;
  const deps: CommandDeps & RespondDeps = {
    users,
    messages: createMessageRepo(db),
    workflows: createWorkflowRepo(db),
    llm,
    clock: () => 42,
    ownerSlackId: OWNER,
    botInfo: () => ({ botName: "Evie", model: "claude-cli (opus)" }),
    newSessionId: () => SESSION,
    toolPolicy: () => ({ skipPermissions: true, cwd: "/work" }),
    threadQueue: createThreadQueue(),
    runs: createRunRegistry(),
    slack,
    commandPrefix: "//jv",
    continueTimer: (fn, ms) => {
      timers.push({ fn, ms });
    },
  };
  deps.runTurn = async (req) => {
    const result = await respond(deps, {
      channelId: req.channelId,
      slackUserId: req.slackUserId,
      text: req.text,
      threadTs: req.threadTs,
      messageTs: "999.9",
      keepSession: req.keepSession,
      autoContinue: req.autoContinue,
    });
    if (result.kind !== "ignored" && result.text.trim()) await slack.post(req.channelId, result.text, req.threadTs);
  };
  /** Fire the oldest pending timer and wait for the turn it starts. */
  const tick = async (): Promise<boolean> => {
    const next = timers.shift();
    if (!next) return false;
    const before = calls.length;
    next.fn();
    // the kick is fire-and-forget; let it, and the queued turn, run
    for (let i = 0; i < 20 && calls.length === before; i++) await Bun.sleep(1);
    await Bun.sleep(1);
    return true;
  };
  const start = (task = "rebuild the blog") => dispatchCommand(deps, owner, C, `workflow ${task}`, { threadTs: T });
  const say = (text: string, who = OWNER) =>
    respond(deps, { channelId: C, slackUserId: who, text, threadTs: T, messageTs: "200.1" });
  const live = () => deps.workflows!.activeFor(C, T);
  return { deps, calls, timers, posts, tick, start, say, live };
};

const keepGoing: Reply = () => "did one step.\n[continue]";

describe("workflow auto-continue", () => {
  test("a turn ending in [continue] hides the marker and queues the next step through respond", async () => {
    const b = build(keepGoing);
    const out = await b.start();
    expect(out).toBe("did one step.");
    expect(b.timers).toHaveLength(1);
    expect(b.timers[0]!.ms).toBeGreaterThan(0);
    expect(b.live()?.continueAs).toBe(OWNER);

    await b.tick();
    expect(b.calls).toHaveLength(2);
    // same session, resumed, told to carry on
    expect(b.calls[1]?.session).toEqual({ id: SESSION, resume: true });
    expect(b.calls[1]?.messages.map((m) => m.content)).toEqual([CONTINUE_MESSAGE]);
    expect(b.calls[1]?.bill?.actor).toBe(OWNER);
    // its reply was posted without the marker, and the chain goes on
    expect(b.posts.at(-1)?.text).toBe("did one step.");
    expect(b.live()?.autoTurns).toBe(1);
    expect(b.timers).toHaveLength(1);
  });

  test("a turn without the marker waits for a human", async () => {
    const b = build(() => "which theme do you want, A or B?");
    await b.start();
    expect(b.timers).toHaveLength(0);
    expect(b.live()?.continueAs).toBeUndefined();
  });

  test("it pauses after the cap with one line saying how to resume", async () => {
    const b = build(keepGoing);
    await b.start();
    for (let i = 0; i < AUTO_CONTINUE_CAP; i++) expect(await b.tick()).toBe(true);
    expect(b.calls).toHaveLength(AUTO_CONTINUE_CAP + 1);
    expect(b.timers).toHaveLength(0);
    const paused = b.posts.filter((p) => p.text.includes("paused"));
    expect(paused).toHaveLength(1);
    expect(paused[0]?.text).toContain("carry on");
    expect(b.live()?.continueAs).toBeUndefined();

    // a human message resumes it, with the count back at zero
    await b.say("carry on");
    expect(b.live()?.autoTurns).toBe(0);
    expect(b.timers).toHaveLength(1);
    await b.tick();
    expect(b.live()?.autoTurns).toBe(1);
  });

  test("a human message resets the count and supersedes a pending step", async () => {
    const b = build(keepGoing);
    await b.start();
    await b.tick();
    await b.tick();
    expect(b.live()?.autoTurns).toBe(2);
    const stale = b.timers.shift()!;

    await b.say("use the dark theme");
    expect(b.live()?.autoTurns).toBe(0);
    const calls = b.calls.length;
    // the step queued before the human spoke does nothing
    stale.fn();
    await Bun.sleep(5);
    expect(b.calls).toHaveLength(calls);
    // the human turn's own request is the one that runs
    expect(b.timers).toHaveLength(1);
    await b.tick();
    expect(b.calls).toHaveLength(calls + 1);
  });

  test("an auto step queued behind a human message stands down", async () => {
    const b = build(keepGoing);
    await b.start();
    const w = b.live()!;
    // claim the step as the timer would, then let a human get in first
    expect(b.deps.workflows!.takeContinue(w.id, b.live()!.continueSeq, 42)).toBe(true);
    b.deps.workflows!.humanTurn(w.id);
    const res = await respond(b.deps, {
      channelId: C,
      slackUserId: OWNER,
      text: CONTINUE_MESSAGE,
      threadTs: T,
      autoContinue: true,
    });
    expect(res.kind).toBe("ignored");
    expect(b.calls).toHaveLength(1);
  });

  test("no next step once the workflow is stopped", async () => {
    const b = build(keepGoing);
    await b.start();
    await dispatchCommand(b.deps, owner, C, "workflow stop", { threadTs: T });
    expect(await b.tick()).toBe(true);
    expect(b.calls).toHaveLength(1);
    expect(b.posts.some((p) => p.text.includes("paused"))).toBe(false);
  });

  test("a workflow stopped while its turn ran does not continue", async () => {
    const b = build((p) => {
      // stopped by someone while this turn was running
      const w = b.deps.workflows!.activeFor(C, T);
      if (w && p.session?.resume) b.deps.workflows!.stop(w.id, 42);
      return "did one step.\n[continue]";
    });
    await b.start();
    await b.tick();
    expect(b.calls).toHaveLength(2);
    expect(b.timers).toHaveLength(0);
  });

  test("an aborted turn does not continue, whatever it said", async () => {
    const b = build((p) => {
      if (p.session?.resume) b.deps.runs!.stopThread(sessionThreadKey(C, T), OWNER);
      return "half way\n[continue]";
    });
    await b.start();
    await b.tick();
    expect(b.calls).toHaveLength(2);
    expect(b.timers).toHaveLength(0);
  });

  test("the next step runs as whoever drove the last one, with their role checked", async () => {
    const b = build(keepGoing);
    await b.start();
    b.timers.length = 0;
    await b.say("go on", EXEC);
    expect(b.live()?.continueAs).toBe(EXEC);
    // demoted meanwhile: the step is dropped, not handed to the chat brain
    b.deps.users.upsert({ slackId: EXEC, role: "pal", displayName: "Ex", addedBy: "x", createdAt: 1 });
    const before = b.calls.length;
    await b.tick();
    expect(b.calls).toHaveLength(before);
  });

  test("a pending step survives a restart", async () => {
    const b = build(keepGoing);
    await b.start();
    b.timers.length = 0; // the process died before the timer fired
    expect(b.live()?.continueAs).toBe(OWNER);

    expect(resumeContinues(b.deps, 1)).toBe(1);
    await b.tick();
    expect(b.calls).toHaveLength(2);
    expect(b.calls[1]?.messages.map((m) => m.content)).toEqual([CONTINUE_MESSAGE]);
  });

  test("the marker never reaches the live stream", async () => {
    const b = build(keepGoing);
    await b.start("x");
    const seen: LlmStreamEvent[] = [];
    b.deps.llm = {
      complete: async () => "",
      stream: async (_p, sink) => {
        for (const delta of ["step done.\n[con", "tinue]"]) sink({ type: "text", delta });
        return "step done.\n[continue]";
      },
    };
    const turn = await runWorkflowTurn(b.deps, b.live()!, owner, "go", false, (e) => seen.push(e));
    expect(turn).toEqual({ text: "step done.", wantsContinue: true });
    const streamed = seen.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(streamed).not.toContain("[");
  });
});
