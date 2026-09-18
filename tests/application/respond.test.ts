import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { respond, type RespondDeps } from "../../src/application/respond.ts";
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

  test("owner can add a member via command end to end", async () => {
    const deps = build(llm("x"));
    await respond(deps, { channelId: "C1", slackUserId: OWNER, text: "!add <@UNEW> member" });
    expect(deps.users.get("UNEW")?.role).toBe("pal");
  });
});
