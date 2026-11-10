import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import { createThreadQueue } from "../../src/application/threadQueue.ts";
import { createRunRegistry, RESTART_STOPPER } from "../../src/application/runRegistry.ts";
import { createWorkflowRepo } from "../../src/infrastructure/db/workflowRepo.ts";
import { createTurnLogRepo } from "../../src/infrastructure/db/turnLogRepo.ts";
import { createWatchRepo } from "../../src/infrastructure/db/watchRepo.ts";
import { tellPrompt } from "../../src/domain/tellPrompt.ts";
import { createCommandTickets } from "../../src/application/commandTickets.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { LlmPort } from "../../src/application/ports.ts";
import { createRolePolicyRepo } from "../../src/infrastructure/db/rolePolicyRepo.ts";
import { defaultRolePolicy } from "../../src/domain/rolePolicy.ts";
import { disabledRoleOf, enforceRolePolicies } from "../../src/application/rolePolicies.ts";

const OWNER = "U0OWNER0001";

const build = (llm: LlmPort): RespondDeps => {
  const db = openDatabase(":memory:");
  let t = 1;
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    llm,
    clock: () => t++,
    ownerSlackId: OWNER,
    contextWindow: 10,
  };
};

const llm = (r: string): LlmPort => ({ complete: async () => r });

/** Every port method a no-op; a test overrides only what it asserts on. */
const quietSlack: SlackAdminPort = {
  listConversations: async () => [],
  history: async () => ({ messages: [] }),
  replies: async () => [],
  update: async () => {},
  remove: async () => {},
  post: async () => {},
  postDm: async () => undefined,
  postDmInteractive: async () => undefined,
  postInteractive: async () => undefined,
  postMenu: async () => undefined,
  settleInteractive: async () => {},
  addReactions: async () => 0,
  botUserId: async () => "UBOT",
  resolveNames: async () => ({}),
};

describe("respond", () => {
  test("routes commands to the command layer without hitting the llm", async () => {
    let called = false;
    const deps = build({ complete: async () => ((called = true), "x") });
    const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "!whoami" });
    expect(res.kind).toBe("reply");
    if (res.kind === "reply") expect(res.text).toContain("owner");
    expect(called).toBe(false);
  });

  test("routes plain chat to the llm", async () => {
    const deps = build(llm("Obviously."));
    const res = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "you there?" });
    expect(res).toEqual({ kind: "reply", text: "Obviously." });
  });

  test("denies unknown users on commands too", async () => {
    const deps = build(llm("x"));
    const res = await respond(deps, { channelId: "C1", slackUserId: "Ux", text: "!users" });
    expect(res.kind).toBe("denied");
  });

  test("a switched-off role reaches neither commands nor chat, and is told why", async () => {
    const deps = build(llm("should not run"));
    const policies = createRolePolicyRepo(openDatabase(":memory:"));
    deps.users.upsert({ slackId: "Uadm", role: "admin", displayName: "A", addedBy: "x", createdAt: 1 });
    policies.save({ ...defaultRolePolicy("admin"), enabled: false }, "dashboard", 1);
    const gated: RespondDeps = {
      ...deps,
      users: enforceRolePolicies(deps.users, policies.get),
      roleDisabled: disabledRoleOf(deps.users, policies.get),
    };
    for (const text of ["!whoami", "hello there"]) {
      const res = await respond(gated, { channelId: "C1", slackUserId: "Uadm", text });
      expect(res).toEqual({ kind: "denied", text: expect.stringContaining("admin role is switched off") });
    }
    // The owner is untouched by any of it.
    expect((await respond(gated, { channelId: "C1", slackUserId: OWNER, text: "!whoami" })).kind).toBe("reply");
  });

  test("asking for a review in words runs the command, not a chat reply", async () => {
    // the gap this closes: `@bot review <url>` reached the chat brain, which
    // talked about the review - and about the token - instead of running one
    // and offering the box that takes it
    let asked: string | undefined;
    const deps = build({
      complete: async (p) => {
        asked = p.system;
        return "I would love to review that for you";
      },
    });
    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "<@UBOT> review https://github.com/o/r/pull/1",
    });

    expect(asked).toBeUndefined(); // the chat brain never ran
    if (res.kind === "reply") {
      // the review command answered: no token store wired here, so it refuses
      expect(res.text).toContain("caller's own");
    }
  });

  test("a tell steer naming a PR and 'review' reaches the session, it does not run the review", async () => {
    // `tell <thread> ... <pr url> ... review` answered "sent" and then ran
    // `review` on the PR in the target thread; the session never saw the steer
    let seen = "";
    const deps = build({
      complete: async (p) => {
        seen = JSON.stringify(p);
        return "NO_REPLY";
      },
    });
    const steer = tellPrompt(OWNER, "please review https://github.com/o/r/pull/1 when CI is green");
    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: steer,
      threadTs: "1.0",
      keepSession: true,
      unprompted: true,
    });

    expect(seen).toContain("internal steer"); // the chat brain ran on the steer
    expect(seen).toContain("pull/1");
    expect(res).toEqual({ kind: "reply", text: "NO_REPLY" });
  });

  test("talking about a PR is still just talking", async () => {
    const deps = build(llm("it looked fine to me"));
    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "<@UBOT> what did you make of https://github.com/o/r/pull/1",
    });
    expect(res).toEqual({ kind: "reply", text: "it looked fine to me" });
  });

  test("two messages in one thread take turns, instead of doing the work twice", async () => {
    // the failure this exists for: "create a PR" and "do all" three minutes
    // apart ran at once and opened two pull requests for the same task
    let running = 0;
    let overlapped = false;
    const deps = build({
      complete: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "100.1" };
    await Promise.all([
      respond(deps, { ...inbound, text: "add it and create a PR", messageTs: "100.1" }),
      respond(deps, { ...inbound, text: "do all", messageTs: "100.2" }),
    ]);

    expect(overlapped).toBe(false);
  });

  test("a second thread is not held up by the first", async () => {
    const deps = build({
      complete: async (p) => {
        if (p.messages.some((m) => m.content.includes("slow"))) {
          await new Promise((r) => setTimeout(r, 40));
        }
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();

    const slow = respond(deps, { channelId: "C1", slackUserId: OWNER, text: "slow one", threadTs: "1.1", messageTs: "1.1" });
    const other = await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "quick", threadTs: "2.1", messageTs: "2.1" });
    expect(other).toEqual({ kind: "reply", text: "ok" });
    await slow;
  });

  test("a running turn can be stopped, and stopping is not reported as a failure", async () => {
    // the point: a turn may run for the better part of an hour, and waiting one
    // out is not a way to correct course
    const runs = createRunRegistry();
    let started = false;
    const deps = build({
      complete: async (p) => {
        started = true;
        // what the CLI adapter does on abort: kill the child, which surfaces
        // exactly as the timeout's own kill
        await new Promise<void>((_resolve, reject) => {
          p.signal?.addEventListener("abort", () => reject(new Error("claude CLI exited with code 143: no output")));
        });
        return "never";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;

    const turn = respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "dig through every log group",
      threadTs: "100.1",
      messageTs: "100.1",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    const running = runs.current("C1:100.1");
    expect(running?.what).toBe("dig through every log group");

    runs.stop(running!.id, OWNER);
    // it comes back quietly rather than as "I hit an error": whoever stopped it
    // already knows, and the thread has been told
    expect(await turn).toEqual({ kind: "ignored" });
  });

  test("a message queued behind a running turn posts nothing, and still runs after it", async () => {
    const posted: string[] = [];
    const seen: string[] = [];
    const order: string[] = [];
    const deps = build({
      complete: async (p) => {
        const asked = p.messages[p.messages.length - 1]?.content ?? "";
        seen.push(asked);
        order.push(`start ${asked}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end ${asked}`);
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = createRunRegistry();
    deps.slack = {
      ...quietSlack,
      post: async (channel, text) => {
        posted.push(text);
        return { channel, ts: `9.${posted.length}` };
      },
      postInteractive: async () => {
        throw new Error("a queued message must not post anything");
      },
    };

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "200.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "200.1" });
    await new Promise((r) => setTimeout(r, 10));
    let started = 0;
    const second = respond(deps, { ...inbound, text: "and this", messageTs: "200.2" }, undefined, () => void started++);
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(0); // still waiting its turn
    expect(posted).toEqual([]); // and nothing said about it

    await Promise.all([first, second]);
    expect(posted).toEqual([]);
    expect(started).toBe(1);
    expect(seen).toEqual(["the long one", "and this"]);
    expect(order).toEqual(["start the long one", "end the long one", "start and this", "end and this"]);
  });

  test("a watch hand-back queued behind a running turn posts nothing either", async () => {
    const posted: string[] = [];
    const deps = build({
      complete: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = createRunRegistry();
    deps.slack = {
      ...quietSlack,
      post: async (channel, text) => {
        posted.push(text);
        return { channel, ts: `9.${posted.length}` };
      },
    };

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "500.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "500.1" });
    await new Promise((r) => setTimeout(r, 10));
    const handBack = respond(deps, { ...inbound, text: "watch ready", messageTs: "500.2", unprompted: true });

    await Promise.all([first, handBack]);
    expect(posted).toEqual([]);
  });

  test("a message dropped before it ran never reaches the brain", async () => {
    const runs = createRunRegistry();
    const seen: string[] = [];
    const deps = build({
      complete: async (p) => {
        seen.push(p.messages[p.messages.length - 1]?.content ?? "");
        await new Promise((r) => setTimeout(r, 30));
        return "ok";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "300.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "300.1" });
    await new Promise((r) => setTimeout(r, 10));
    const second = respond(deps, { ...inbound, text: "never mind this", messageTs: "300.2" });

    // take the queued one back before its turn comes round
    const queued = runs.inThread("C1:300.1").find((r) => r.state === "queued");
    expect(queued?.what).toBe("never mind this");
    runs.stop(queued!.id, OWNER);

    await Promise.all([first, second]);
    expect(seen).toEqual(["the long one"]); // the dropped one never spawned
  });

  test("owner can add a member via command end to end", async () => {
    const deps = build(llm("x"));
    await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "!add <@UNEW> member" });
    expect(deps.users.get("UNEW")?.role).toBe("pal");
  });
});

describe("recording how a turn ended", () => {
  const withTurns = (llmPort: LlmPort) => {
    const deps = build(llmPort);
    const db = openDatabase(":memory:");
    const turns = createTurnLogRepo(db);
    return { deps: { ...deps, turns } as RespondDeps, turns };
  };

  const inbound = {
    channelId: "C1",
    slackUserId: OWNER,
    text: "why is the form slow",
    threadTs: "9.9",
    messageTs: "9.9",
    viaSlash: false,
  };

  test("a turn that worked is written down", async () => {
    const { deps, turns } = withTurns(llm("because of FINAL"));
    await respond(deps, inbound);
    const [t] = turns.since(0);
    expect(t?.outcome).toBe("ok");
    expect(t?.request).toBe("why is the form slow");
    expect(t?.threadTs).toBe("9.9");
    expect(t?.slackUserId).toBe(OWNER);
  });

  test("a turn that threw is written down WITH the error, not just lost to stderr", async () => {
    const { deps, turns } = withTurns({
      complete: async () => {
        throw new Error("disk I/O error");
      },
    });
    await expect(respond(deps, inbound)).rejects.toThrow("disk I/O error");
    const [t] = turns.since(0);
    expect(t?.outcome).toBe("failed");
    expect(t?.error).toContain("disk I/O error");
    // and it is the thing `mindful continue` will re-run
    expect(turns.stuckThreads(0)).toHaveLength(1);
  });

  test("a turn cut for a restart after it spoke is recorded stopped, not answered", async () => {
    // a streamed turn killed after its first words returns the fragment
    // instead of throwing; finishing it as the reply would leave a half answer
    // with a usage footer, and log as done a turn the next process re-runs
    const runs = createRunRegistry();
    const { deps, turns } = withTurns({
      complete: async () => {
        const running = runs.current("C1:9.9");
        runs.stop(running!.id, RESTART_STOPPER);
        return "the form is slow bec";
      },
    });
    deps.threadQueue = createThreadQueue();
    deps.runs = runs;
    expect(await respond(deps, inbound)).toEqual({ kind: "ignored" });
    const [t] = turns.since(0);
    expect(t?.outcome).toBe("stopped");
  });

  test("an instance with no turn log still answers", async () => {
    const deps = build(llm("fine"));
    const out = await respond(deps, inbound);
    expect(out.kind).toBe("reply");
  });
});

describe("a turn started by a watch can actually DO things", () => {
  /**
   * The follow-up turn a watch hands back is an ordinary turn in every way
   * that matters, and the ways that matter are easy to lose: without a command
   * ticket it can only talk about promoting, and without the command rules it
   * does not know the helper exists. Both arrive through `handleMessage`, so
   * both are checked here rather than assumed from the wiring.
   */
  const build2 = () => {
    const db = openDatabase(":memory:");
    let t = 1;
    const users = createUserRepo(db);
    users.upsert({
      slackId: "U7",
      role: "admin",
      displayName: "Kai",
      addedBy: "system",
      createdAt: 0,
    });
    const seen: { system: string; runTicket?: string }[] = [];
    const deps: RespondDeps = {
      users,
      messages: createMessageRepo(db),
      llm: {
        complete: async (p) => {
          seen.push({ system: p.system, runTicket: p.runTicket });
          return "promoting now";
        },
      },
      clock: () => t++,
      ownerSlackId: OWNER,
      contextWindow: 10,
      commandTickets: createCommandTickets(() => 1, () => "TICKET"),
      runScript: "/x/jarvis-run.sh",
      runUrl: "http://localhost/api/commands/run",
      commandPrefix: "//jarvis",
      watches: createWatchRepo(db),
    };
    return { deps, seen };
  };

  const fired = {
    channelId: "C1",
    slackUserId: "U7",
    text: "The thing you were waiting for is ready. Carry on with exactly this: promote be US then SG",
    threadTs: "9.9",
    messageTs: "9.9",
    viaSlash: false,
  };

  test("it gets a command ticket, so it can run them itself", async () => {
    const { deps, seen } = build2();
    await respond(deps, fired);
    expect(seen[0]?.runTicket).toBe("TICKET");
  });

  test("and it is told how, so it does not hand the job back", async () => {
    const { deps, seen } = build2();
    await respond(deps, fired);
    expect(seen[0]?.system).toContain("/x/jarvis-run.sh");
    expect(seen[0]?.system).toContain("//jarvis");
  });

  test("it can set another watch, so a chain of waits does not need a person", async () => {
    // wait for the build, promote, then wait for the deploy
    const { deps, seen } = build2();
    await respond(deps, fired);
    expect(seen[0]?.system).toContain("Waiting for something to finish");
  });
});

describe("a workflow worker does not hold a restart open", () => {
  /** What the registry held while the turn was actually in flight. */
  const runDuring = async (threadTs: string, withWorkflow: boolean) => {
    const db = openDatabase(":memory:");
    let t = 1;
    const runs = createRunRegistry(() => t);
    const workflows = createWorkflowRepo(db);
    if (withWorkflow) {
      workflows.start({ channelId: "C1", threadTs, sessionId: "s1", task: "the blog", startedBy: OWNER }, 1);
    }
    let inFlight: ReturnType<typeof runs.all> = [];
    const deps: RespondDeps = {
      users: createUserRepo(db),
      messages: createMessageRepo(db),
      // Looked at from inside the call, which is the only moment the run exists
      llm: { complete: async () => ((inFlight = runs.all()), "done") },
      clock: () => t++,
      ownerSlackId: OWNER,
      contextWindow: 10,
      runs,
      workflows,
    };
    await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "carry on",
      threadTs,
      messageTs: threadTs,
      viaSlash: false,
    });
    return inFlight;
  };

  test("a turn in a workflow thread is marked background", async () => {
    // the incident: a worker running nine minutes kept the bot deaf, because
    // idleness counted it. A cut worker is redelivered on the same session,
    // so waiting on one only costs everybody else their replies
    const runs = await runDuring("9.9", true);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.background).toBe(true);
  });

  test("an ordinary thread's turn is not background, and still holds it open", async () => {
    const runs = await runDuring("8.8", false);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.background).toBeUndefined();
  });
});
