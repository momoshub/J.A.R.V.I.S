import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createWorkflowRepo } from "../../src/infrastructure/db/workflowRepo.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
import { WORKFLOW_TIMEOUT_MS } from "../../src/application/workflow.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmCompleteParams, LlmPort } from "../../src/application/ports.ts";

const OWNER = "U0OWNER0001";
const SESSION = "11111111-2222-3333-4444-555555555555";
const FRONT = "99999999-2222-3333-4444-555555555555";

const actor = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: OWNER,
  role: "owner",
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
  ...over,
});

const build = () => {
  const db = openDatabase(":memory:");
  const calls: LlmCompleteParams[] = [];
  const llm: LlmPort = {
    complete: async (p) => {
      calls.push(p);
      return "on it, cloned the repo and read the handler";
    },
  };
  const users = createUserRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  const deps: CommandDeps & RespondDeps = {
    users,
    messages: createMessageRepo(db),
    workflows: createWorkflowRepo(db),
    llm,
    clock: () => 42,
    ownerSlackId: OWNER,
    botInfo: () => ({ botName: "Jarvis", model: "claude-cli (opus)" }),
    newSessionId: (() => {
      let n = 0;
      return () => (n++ === 0 ? SESSION : FRONT);
    })(),
    toolPolicy: () => ({ skipPermissions: true, cwd: "/work" }),
  };
  return { deps, calls };
};

describe("workflow command", () => {
  test("starts a session bound to the thread and runs the first turn", async () => {
    const { deps, calls } = build();
    const out = await dispatchCommand(deps, actor(), "C1", "workflow add a retry to the webhook", {
      threadTs: "100.1",
    });

    expect(out).toContain("cloned the repo");
    const live = deps.workflows!.activeFor("C1", "100.1");
    expect(live?.sessionId).toBe(SESSION);
    expect(live?.task).toBe("add a retry to the webhook");
    expect(live?.turns).toBe(1);

    // first turn claims the session id, and gets the long timeout
    expect(calls[0]?.session).toEqual({ id: SESSION, resume: false });
    expect(calls[0]?.policy?.timeoutMs).toBe(WORKFLOW_TIMEOUT_MS);
    expect(calls[0]?.system).toContain("add a retry to the webhook");
  });

  test("a workflow needs a thread to live in", async () => {
    const { deps } = build();
    const out = await dispatchCommand(deps, actor(), "C1", "workflow do a thing");
    expect(out).toContain("thread");
    expect(deps.workflows!.listActive()).toHaveLength(0);
  });

  test("one workflow per thread; status and stop report on it", async () => {
    const { deps } = build();
    await dispatchCommand(deps, actor(), "C1", "workflow first task", { threadTs: "100.1" });

    const again = await dispatchCommand(deps, actor(), "C1", "workflow second task", { threadTs: "100.1" });
    expect(again).toContain("already running");

    expect(await dispatchCommand(deps, actor(), "C1", "workflow status", { threadTs: "100.1" })).toContain(
      "first task",
    );

    const stopped = await dispatchCommand(deps, actor(), "C1", "workflow stop", { threadTs: "100.1" });
    expect(stopped).toContain("stopped");
    expect(deps.workflows!.activeFor("C1", "100.1")).toBeUndefined();

    // and the thread is free to host a new one
    await dispatchCommand(deps, actor(), "C1", "workflow third task", { threadTs: "100.1" });
    expect(deps.workflows!.activeFor("C1", "100.1")?.task).toBe("third task");
  });

  test("pal cannot start one", async () => {
    const { deps } = build();
    const pal = actor({ slackId: "U9", role: "pal" });
    expect(await dispatchCommand(deps, pal, "C1", "workflow do a thing", { threadTs: "100.1" })).toContain("access");
  });
});

describe("workflow routing", () => {
  test("plain messages in the thread go to the front's own session, not the worker's", async () => {
    const { deps, calls } = build();
    await dispatchCommand(deps, actor(), "C1", "workflow add a retry", { threadTs: "100.1" });

    const res = await respond(deps, {
      channelId: "C1",
      slackUserId: OWNER,
      text: "use exponential backoff",
      threadTs: "100.1",
      messageTs: "100.2",
    });

    expect(res.kind).toBe("reply");
    expect(calls).toHaveLength(2);
    // the front claims a session of its own, read-only and quick
    expect(calls[1]?.session).toEqual({ id: FRONT, resume: false });
    expect(calls[1]?.bill?.kind).toBe("workflow-front");
    expect(calls[1]?.policy?.skipPermissions).toBe(false);
    expect(calls[1]?.policy?.timeoutMs).toBeLessThanOrEqual(300_000);
    // the new message goes up with a digest of where the worker is
    const content = calls[1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(content).toContain("Progress digest");
    expect(content).toContain("on it, cloned the repo");
    expect(content).toContain("use exponential backoff");
    // the worker did not take a turn
    expect(deps.workflows!.activeFor("C1", "100.1")?.turns).toBe(1);

    // and the next message resumes the front's session
    await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "status?", threadTs: "100.1" });
    expect(calls[2]?.session).toEqual({ id: FRONT, resume: true });
  });

  test("a neighbouring thread is untouched by the workflow", async () => {
    const { deps, calls } = build();
    await dispatchCommand(deps, actor(), "C1", "workflow add a retry", { threadTs: "100.1" });

    await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "hey", threadTs: "999.9" });
    expect(calls[1]?.session).toBeUndefined(); // ordinary chat, no session
  });

  test("someone below executer chats normally in a workflow thread", async () => {
    const { deps, calls } = build();
    deps.users.upsert({ slackId: "Upal", role: "pal", displayName: "", addedBy: "x", createdAt: 1 });
    await dispatchCommand(deps, actor(), "C1", "workflow add a retry", { threadTs: "100.1" });

    await respond(deps, { channelId: "C1", slackUserId: "Upal", text: "how is it going", threadTs: "100.1" });
    expect(calls[1]?.session).toBeUndefined(); // did not get to steer the task
    expect(deps.workflows!.activeFor("C1", "100.1")?.turns).toBe(1);
  });

  test("a stopped workflow hands the thread back to normal chat", async () => {
    const { deps, calls } = build();
    await dispatchCommand(deps, actor(), "C1", "workflow add a retry", { threadTs: "100.1" });
    await dispatchCommand(deps, actor(), "C1", "workflow stop", { threadTs: "100.1" });

    await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "and now?", threadTs: "100.1" });
    expect(calls[1]?.session).toBeUndefined();
  });
});
