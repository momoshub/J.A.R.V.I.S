import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import { createThreadQueue } from "../../src/application/threadQueue.ts";
import { createRunRegistry } from "../../src/application/runRegistry.ts";
import type { SlackAdminPort, InteractiveAction } from "../../src/application/slackAdmin.ts";
import type { LlmPort } from "../../src/application/ports.ts";

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

  test("a busy thread is offered the two ways out, on the notice", async () => {
    const posted: { text: string; actions: readonly InteractiveAction[] }[] = [];
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
      postInteractive: async (_c, text, actions) => {
        posted.push({ text, actions });
        return { channel: "C1", ts: "n1" };
      },
    };

    const inbound = { channelId: "C1", slackUserId: OWNER, threadTs: "200.1" };
    const first = respond(deps, { ...inbound, text: "the long one", messageTs: "200.1" });
    await new Promise((r) => setTimeout(r, 10));
    const second = respond(deps, { ...inbound, text: "actually, this instead", messageTs: "200.2" });

    await Promise.all([first, second]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("the long one"); // names what is in the way
    const labels = posted[0]!.actions.map((a) => a.label);
    expect(labels).toEqual(["Stop that one", "Never mind"]);
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
