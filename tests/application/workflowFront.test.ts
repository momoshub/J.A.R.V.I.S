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
import { runFrontTurn } from "../../src/application/workflow.ts";
import { sessionThreadKey } from "../../src/domain/agentSession.ts";
import { frontKeyOf } from "../../src/domain/workflowFront.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmCompleteParams, LlmPort, LlmStreamEvent } from "../../src/application/ports.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";

const OWNER = "U0OWNER";
const SESSION = "11111111-2222-3333-4444-555555555555";
const FRONT = "99999999-2222-3333-4444-555555555555";
const C = "C1";
const T = "100.1";
const KEY = sessionThreadKey(C, T);

const owner: AllowedUser = { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 0 };

const isFront = (p: LlmCompleteParams): boolean => p.bill?.kind === "workflow-front";
const lastMessage = (p: LlmCompleteParams): string => p.messages.at(-1)?.content ?? "";

type Gate = { wait: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open = () => {};
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
};

/**
 * A bot whose worker steps can be held open (`hold`) so a test can talk to
 * the front while one runs. `worker` and `front` decide what each says.
 */
const build = (opts: { worker: (p: LlmCompleteParams) => string; front: (p: LlmCompleteParams) => string }) => {
  const db = openDatabase(":memory:");
  const calls: LlmCompleteParams[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const posts: { text: string }[] = [];
  let held: Gate | undefined;
  const llm: LlmPort = {
    complete: async (p) => {
      calls.push(p);
      if (isFront(p)) return opts.front(p);
      const g = held;
      if (g) await g.wait;
      if (p.signal?.aborted) throw new Error("claude CLI exited with code 143: no output");
      return opts.worker(p);
    },
  };
  const users = createUserRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  const slack = {
    post: async (_c: string, text: string) => {
      posts.push({ text });
      return { channel: C, ts: `${posts.length}.0` };
    },
    remove: async () => {},
  } as unknown as SlackAdminPort;
  let n = 0;
  const deps: CommandDeps & RespondDeps = {
    users,
    messages: createMessageRepo(db),
    workflows: createWorkflowRepo(db),
    llm,
    clock: () => 1_000_000,
    ownerSlackId: OWNER,
    botInfo: () => ({ botName: "Evie", model: "claude-cli (opus)" }),
    newSessionId: () => (n++ === 0 ? SESSION : FRONT),
    toolPolicy: () => ({ skipPermissions: true, cwd: "/work" }),
    threadQueue: createThreadQueue(),
    runs: createRunRegistry(),
    slack,
    commandPrefix: "//jv",
    continueTimer: (fn, ms) => {
      timers.push({ fn, ms });
    },
    workerCalls: () => [{ at: new Date(990_000).toISOString(), name: "Bash", input: '{"command":"bun test"}' }],
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
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Bun.sleep(1);
  };
  /** Fire the oldest timer; with a held gate the step it starts stays running. */
  const fire = async () => {
    const next = timers.shift();
    if (!next) return false;
    next.fn();
    await settle();
    return true;
  };
  const hold = (): Gate => {
    held = gate();
    return held;
  };
  const release = async (g: Gate) => {
    held = undefined;
    g.open();
    await settle();
  };
  const start = () => dispatchCommand(deps, owner, C, "workflow rebuild the blog", { threadTs: T });
  const say = (text: string) => respond(deps, { channelId: C, slackUserId: OWNER, text, threadTs: T, messageTs: "200.1" });
  const live = () => deps.workflows!.activeFor(C, T);
  const workerCalls = () => calls.filter((c) => !isFront(c));
  const frontCalls = () => calls.filter(isFront);
  return { deps, calls, timers, posts, fire, hold, release, start, say, live, workerCalls, frontCalls };
};

describe("workflow front and worker", () => {
  test("a human message is answered on the front's queue while a worker step runs", async () => {
    const b = build({ worker: () => "did a step\n[continue]", front: () => "it is running the tests" });
    await b.start();
    const g = b.hold();
    await b.fire(); // worker step 2 starts and blocks
    expect(b.deps.runs!.current(KEY)).toBeDefined();
    expect(b.deps.threadQueue!.depth(KEY)).toBe(1);

    const res = await b.say("status?");
    expect(res).toEqual({ kind: "reply", text: "it is running the tests", by: "workflow front" });
    // the worker's queue never saw it
    expect(b.deps.threadQueue!.depth(KEY)).toBe(1);
    expect(b.deps.threadQueue!.depth(frontKeyOf(KEY))).toBe(0);
    const front = b.frontCalls()[0]!;
    expect(front.session).toEqual({ id: FRONT, resume: false });
    expect(lastMessage(front)).toContain("running a step right now");
    expect(lastMessage(front)).toContain("Bash: bun test");
    expect(lastMessage(front)).toContain("did a step");
    expect(lastMessage(front)).toContain("status?");

    await b.release(g);
    expect(b.workerCalls()).toHaveLength(2);
  });

  test("a steer is stripped, stored, delivered to the next worker step and cleared", async () => {
    const b = build({
      worker: () => "did a step\n[continue]",
      front: () => "Passing that on.\n[steer] use the dark theme",
    });
    await b.start();
    const g = b.hold();
    await b.fire(); // a step is running

    const res = await b.say("dark theme please");
    expect(res).toEqual({ kind: "reply", text: "Passing that on.", by: "workflow front" });
    expect(b.live()?.steers.map((s) => s.text)).toEqual(["use the dark theme"]);
    // the worker is busy: nothing extra is kicked, it lands at the step boundary
    expect(b.timers).toHaveLength(0);

    await b.release(g); // that step ends, asks to continue
    expect(b.timers).toHaveLength(1);
    await b.fire();
    const step = b.workerCalls().at(-1)!;
    expect(lastMessage(step)).toContain(`Kai (<@${OWNER}>) said mid-task: use the dark theme`);
    expect(step.session).toEqual({ id: SESSION, resume: true });
    expect(b.live()?.steers).toEqual([]);
  });

  test("steers that land mid-step get a next step even if that step did not ask for one", async () => {
    let asked = false;
    const b = build({
      worker: () => (asked ? "done" : "which theme, A or B?"),
      front: () => "ok\n[steer] use theme A",
    });
    await b.start(); // asks a question: idle
    const step = b.deps.workflows!.requestContinue(b.live()!.id, OWNER, 1)!;
    b.deps.workflows!.takeContinue(b.live()!.id, step, 1);
    const g = b.hold();
    const running = respond(b.deps, { channelId: C, slackUserId: OWNER, text: "x", threadTs: T, autoContinue: true });
    await Bun.sleep(2);
    await b.say("A");
    expect(b.timers).toHaveLength(0);
    asked = true;
    await b.release(g);
    await running;
    // the step had no [continue], but a steer is waiting: one more step runs for it
    expect(b.timers).toHaveLength(1);
    await b.fire();
    expect(lastMessage(b.workerCalls().at(-1)!)).toContain("use theme A");
  });

  test("an idle worker is kicked by a steer right away, with the count reset", async () => {
    const b = build({ worker: () => "which theme, A or B?", front: () => "Got it.\n[steer] use theme A" });
    await b.start();
    expect(b.timers).toHaveLength(0); // blocked on a question: idle
    b.deps.workflows!.recordTurn(b.live()!.id, 1);

    await b.say("A please");
    expect(b.timers).toHaveLength(1);
    expect(b.timers[0]!.ms).toBe(0);
    expect(b.live()?.autoTurns).toBe(0);
    await b.fire();
    expect(b.workerCalls()).toHaveLength(2);
    expect(lastMessage(b.workerCalls()[1]!)).toContain("said mid-task: use theme A");
    expect(b.live()?.autoTurns).toBe(1);
    expect(b.live()?.steers).toEqual([]);
  });

  test("a plain question does not steer or wake the worker", async () => {
    const b = build({ worker: () => "done, PR merged", front: () => "It finished - the PR is merged." });
    await b.start();
    await b.say("how did it go?");
    expect(b.timers).toHaveLength(0);
    expect(b.workerCalls()).toHaveLength(1);
    expect(b.live()?.steers).toEqual([]);
  });

  test("workflow stop ends the running worker step and the steers with it", async () => {
    const b = build({ worker: () => "did a step\n[continue]", front: () => "ok\n[steer] also add RSS" });
    await b.start();
    const g = b.hold();
    await b.fire();
    await b.say("add RSS too");
    expect(b.live()?.steers).toHaveLength(1);

    const out = await dispatchCommand(b.deps, owner, C, "workflow stop", { threadTs: T });
    expect(out).toContain("stopped");
    expect(b.deps.runs!.current(KEY)).toBeUndefined();
    await b.release(g);
    // the aborted step does not continue, and nothing is left to deliver
    expect(b.timers).toHaveLength(0);
    expect(b.deps.workflows!.get(1)?.steers).toEqual([]);
    expect(b.workerCalls()).toHaveLength(2);
  });

  test("the stop button's key still reaches the worker step", async () => {
    const b = build({ worker: () => "did a step\n[continue]", front: () => "ok" });
    await b.start();
    const g = b.hold();
    await b.fire();
    expect(b.deps.runs!.stopThread(KEY, OWNER)).toBeDefined();
    await b.release(g);
    expect(b.timers).toHaveLength(0);
  });

  test("pending steers survive a restart and start a step", async () => {
    const b = build({ worker: () => "which theme?", front: () => "ok\n[steer] use theme A" });
    await b.start();
    // passed on while a step ran, then the process died before delivering it
    b.deps.workflows!.addSteers(b.live()!.id, [{ by: OWNER, text: "use theme A", at: 1 }]);
    expect(resumeContinues(b.deps, 1)).toBe(1);
    await b.fire();
    expect(lastMessage(b.workerCalls().at(-1)!)).toContain("use theme A");
    expect(b.live()?.steers).toEqual([]);
  });

  test("steer lines never reach the live stream", async () => {
    const b = build({ worker: () => "which theme?", front: () => "" });
    await b.start();
    const seen: LlmStreamEvent[] = [];
    b.deps.llm = {
      complete: async () => "",
      stream: async (_p, sink) => {
        for (const delta of ["Passing it on.\n[st", "eer] use the da", "rk theme\nAnything else?"]) {
          sink({ type: "text", delta });
        }
        return "Passing it on.\n[steer] use the dark theme\nAnything else?";
      },
    };
    const turn = await runFrontTurn(b.deps, b.live()!, owner, "dark please", "digest", (e) => seen.push(e));
    expect(turn).toEqual({ text: "Passing it on.\nAnything else?", steers: ["use the dark theme"] });
    const streamed = seen.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(streamed).toBe("Passing it on.\nAnything else?");
  });
});
