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
import { AUTO_CONTINUE_CAP, CONTINUE_MESSAGE, RETRY_MESSAGE } from "../../src/domain/workflowContinue.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmCompleteParams, LlmPort, LlmStreamEvent } from "../../src/application/ports.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";

const OWNER = "U0OWNER";
const EXEC = "U0EXEC";
const SESSION = "11111111-2222-3333-4444-555555555555";
const FRONT = "99999999-2222-3333-4444-555555555555";
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
    // the worker's session first, then the front's
    newSessionId: (() => {
      let n = 0;
      return () => (n++ === 0 ? SESSION : FRONT);
    })(),
    toolPolicy: () => ({ skipPermissions: true, cwd: "/work" }),
    threadQueue: createThreadQueue(),
    runs: createRunRegistry(),
    slack,
    commandPrefix: "//jv",
    stepFailures: new Map<number, number>(),
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

/** Front turns are told apart from worker steps by how they are billed. */
const isFront = (p: LlmCompleteParams): boolean => p.bill?.kind === "workflow-front";
const workerCalls = (calls: LlmCompleteParams[]) => calls.filter((c) => !isFront(c));

/** The worker carries on; the front passes on whatever it is told. */
const keepGoing: Reply = (p) =>
  isFront(p) ? `passing it on\n[steer] ${p.messages.at(-1)?.content.split("\n").at(-1)}` : "did one step.\n[continue]";

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

    // a steer through the front resumes it, with the count back at zero
    await b.say("carry on");
    expect(b.live()?.autoTurns).toBe(0);
    expect(b.timers).toHaveLength(1);
    await b.tick();
    expect(b.live()?.autoTurns).toBe(1);
  });

  test("a steer resets the count and rides along with the pending step", async () => {
    const b = build(keepGoing);
    await b.start();
    await b.tick();
    await b.tick();
    expect(b.live()?.autoTurns).toBe(2);
    expect(b.timers).toHaveLength(1);

    await b.say("use the dark theme");
    expect(b.live()?.autoTurns).toBe(0);
    // a step was already pending, so no second one is started
    expect(b.timers).toHaveLength(1);
    await b.tick();
    const last = workerCalls(b.calls).at(-1)!;
    expect(last.messages.at(-1)?.content).toContain("said mid-task: use the dark theme");
    expect(b.live()?.steers).toEqual([]);
  });

  test("no next step once the workflow is stopped", async () => {
    const b = build(keepGoing);
    await b.start();
    await dispatchCommand(b.deps, owner, C, "workflow stop", { threadTs: T });
    expect(await b.tick()).toBe(true);
    expect(b.calls).toHaveLength(1);
    expect(b.posts.some((p) => p.text.includes("paused"))).toBe(false);
  });

  test("workflow stop <thread-link> stops another thread's workflow without posting in it", async () => {
    const b = build(keepGoing);
    await b.start();
    const before = b.posts.length;
    const out = await dispatchCommand(
      b.deps,
      owner,
      "D9",
      `workflow stop <https://x.slack.com/archives/${C}/p1700000000000100?thread_ts=${T}&amp;cid=${C}>`,
      { threadTs: "900.1" },
    );
    expect(out).toContain("stopped the workflow in that thread");
    expect(b.live()).toBeFalsy();
    expect(b.posts.length).toBe(before);
    expect(await b.tick()).toBe(true);
    expect(b.calls).toHaveLength(1);
  });

  test("workflow stop <thread-link> says so when nothing runs there", async () => {
    const b = build(keepGoing);
    const out = await dispatchCommand(b.deps, owner, "D9", `workflow stop https://x.slack.com/archives/${C}/p1700000000000100`, {
      threadTs: "900.1",
    });
    expect(out).toBe("No workflow running in that thread.");
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

  test("a failed step says so and retries once, carrying the notes queued for it", async () => {
    let failing = 0;
    const b = build((p) => {
      if (!isFront(p) && p.session?.resume && failing > 0) {
        failing -= 1;
        throw new Error("claude CLI exited with code 143: no output");
      }
      return keepGoing(p);
    });
    await b.start();
    // a note passed on while the step ran, which then times out
    b.deps.workflows!.addSteers(b.live()!.id, [{ by: OWNER, text: "make the whole card a link", at: 42 }]);
    failing = 1;
    await b.tick();
    expect(b.posts.at(-1)?.text).toContain("retrying once");
    expect(b.posts.at(-1)?.text).toContain("code 143");
    expect(b.live()?.steers).toHaveLength(1);
    expect(b.timers).toHaveLength(1);

    await b.tick();
    const retry = workerCalls(b.calls).at(-1)!;
    expect(retry.messages.at(-1)?.content).toContain(RETRY_MESSAGE);
    expect(retry.messages.at(-1)?.content).toContain("make the whole card a link");
    expect(b.live()?.steers).toEqual([]);
    // it worked, so the next failure gets its own retry again
    expect(b.deps.stepFailures?.size).toBe(0);
  });

  test("a second failure in a row stops and waits for a human, keeping the notes", async () => {
    let failing = 0;
    const b = build((p) => {
      if (!isFront(p) && p.session?.resume && failing > 0) {
        failing -= 1;
        throw new Error("claude CLI exited with code 143: no output");
      }
      return keepGoing(p);
    });
    await b.start();
    b.deps.workflows!.addSteers(b.live()!.id, [{ by: OWNER, text: "fix the hero", at: 42 }]);
    failing = 2;
    await b.tick();
    await b.tick();
    expect(b.posts.at(-1)?.text).toContain("failed again");
    expect(b.timers).toHaveLength(0);
    expect(b.live()?.continueAs).toBeUndefined();
    expect(b.live()?.steers).toHaveLength(1);

    // anyone speaking resumes it
    await b.say("carry on");
    expect(b.timers).toHaveLength(1);
    await b.tick();
    expect(workerCalls(b.calls).at(-1)?.messages.at(-1)?.content).toContain("fix the hero");
  });

  test("a step a steer started runs as whoever steered, with their role checked", async () => {
    const b = build((p) => (isFront(p) ? "ok\n[steer] go on" : "which theme, A or B?"));
    await b.start();
    expect(b.timers).toHaveLength(0);
    await b.say("A", EXEC);
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

  test("a step due while a restart waits stays on its row for the next process", async () => {
    const b = build(keepGoing);
    await b.start();
    let draining = true;
    b.deps.draining = () => draining;
    await b.tick();
    // nothing started, and the step is still pending
    expect(b.calls).toHaveLength(1);
    expect(b.live()?.continueAs).toBe(OWNER);

    // the next process resumes it at boot
    draining = false;
    expect(resumeContinues(b.deps, 1)).toBe(1);
    await b.tick();
    expect(b.calls).toHaveLength(2);
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
