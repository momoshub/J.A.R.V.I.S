import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createCommandLogRepo } from "../../src/infrastructure/db/commandLogRepo.ts";
import { createCommandApprovalRepo } from "../../src/infrastructure/db/commandApprovalRepo.ts";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { dispatchCommand, TRIVIAL_COMMANDS, type CommandDeps } from "../../src/application/commands.ts";
import {
  allowanceFor,
  APPROVE_ACTION,
  limitFor,
  decideCommandApproval,
  PAL_COMMAND_LIMIT,
  PAL_WINDOW_MS,
  REJECT_ACTION,
} from "../../src/application/commandLimits.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { InteractiveAction, SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { LlmPort } from "../../src/application/ports.ts";

const OWNER = "U0OWNER0001";
const PAL = "U0PAL0001";

const actor = (over: Partial<AllowedUser> = {}): AllowedUser => ({
  slackId: PAL,
  role: "pal",
  displayName: "Casey",
  addedBy: "x",
  createdAt: 0,
  ...over,
});

const build = () => {
  const db = openDatabase(":memory:");
  const now = { t: 1_000_000 };
  const posts: { channel: string; text: string; threadTs?: string }[] = [];
  const buttons: InteractiveAction[] = [];
  const settled: string[] = [];
  const slack: SlackAdminPort = {
    listConversations: async () => [],
    history: async () => ({ messages: [] }),
    replies: async () => [],
    update: async () => {},
    remove: async () => {},
    post: async (channel, text, threadTs) => {
      posts.push({ channel, text, threadTs });
    },
    postDm: async (userId, text) => {
      posts.push({ channel: userId, text });
      return { channel: userId, ts: "dm" };
    },
    postDmInteractive: async (userId, text, actions) => {
      posts.push({ channel: userId, text });
      buttons.push(...actions);
      return { channel: userId, ts: "notice" };
    },
    postInteractive: async (channel, text, actions) => {
      posts.push({ channel, text });
      buttons.push(...actions);
      return { channel, ts: "notice" };
    },
    postMenu: async () => undefined,
    settleInteractive: async (_c, _ts, text) => {
      settled.push(text);
    },
    addReactions: async () => 0,
    botUserId: async () => "UBOT",
    resolveNames: async () => ({}),
  };
  const users = createUserRepo(db);
  users.upsert(actor());
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "x", createdAt: 0 });
  users.upsert({ slackId: "U0ADMIN01", role: "admin", displayName: "A", addedBy: "x", createdAt: 0 });
  const deps: CommandDeps = {
    users,
    messages: createMessageRepo(db),
    commandLog: createCommandLogRepo(db),
    commandApprovals: createCommandApprovalRepo(db),
    settings: createSettingsRepo(db),
    slack,
    llm: { complete: async () => "an answer" } as LlmPort,
    botInfo: () => ({ botName: "Evie", model: "m" }),
    clock: () => now.t,
    ownerSlackId: OWNER,
  };
  const spend = async (n: number) => {
    for (let i = 0; i < n; i++) await dispatchCommand(deps, actor(), "C1", `ask question ${i}`);
  };
  return { deps, now, posts, buttons, settled, spend };
};

describe("allowance", () => {
  test("a pal has a fixed number of commands per window", async () => {
    const { deps, spend } = build();
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS).limited).toBe(false);

    await spend(PAL_COMMAND_LIMIT);
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS)).toMatchObject({
      limited: true,
      used: PAL_COMMAND_LIMIT,
      limit: PAL_COMMAND_LIMIT,
    });
  });

  test("trivial commands are free", async () => {
    const { deps } = build();
    for (let i = 0; i < 30; i++) await dispatchCommand(deps, actor(), "C1", "ping");
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS).limited).toBe(false);
  });

  test("the window rolls, it is not a hard reset", async () => {
    const { deps, now, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS).limited).toBe(true);

    now.t += PAL_WINDOW_MS + 1;
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS).limited).toBe(false);
  });

  test("higher roles are not counted at all", async () => {
    const { deps } = build();
    for (const role of ["executer", "admin", "owner"] as const) {
      const who = actor({ slackId: `U0${role.toUpperCase()}`, role });
      for (let i = 0; i < PAL_COMMAND_LIMIT + 5; i++) await dispatchCommand(deps, who, "C1", `ask ${i}`);
      expect(allowanceFor(deps, who, TRIVIAL_COMMANDS).limited).toBe(false);
    }
  });
});

describe("holding a command for approval", () => {
  test("past the limit the command does not run - it is put to the owner with buttons", async () => {
    const { deps, posts, buttons, spend } = build();
    await spend(PAL_COMMAND_LIMIT);

    const out = await dispatchCommand(deps, actor(), "C1", "ask one more thing", { threadTs: "9.9" });

    expect(out).toContain("hit your limit");
    expect(out).toContain(`<@${OWNER}>`);
    const notice = posts.find((p) => p.channel === OWNER);
    expect(notice?.text).toContain("ask one more thing");
    expect(buttons.map((b) => b.actionId)).toEqual([APPROVE_ACTION, REJECT_ACTION]);

    const held = deps.commandApprovals!.listPending();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ slackUserId: PAL, line: "ask one more thing", threadTs: "9.9" });
  });

  test("approving runs it as the requester and answers where they asked", async () => {
    const { deps, posts, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    await dispatchCommand(deps, actor(), "C1", "ask one more thing", { threadTs: "9.9" });
    const held = deps.commandApprovals!.listPending()[0]!;

    const ran: string[] = [];
    const out = await decideCommandApproval(
      deps,
      { slackUserId: OWNER, actionId: APPROVE_ACTION, value: String(held.id) },
      async ({ actor: who, line }) => {
        ran.push(`${who.slackId}:${line}`);
        return "did the thing";
      },
    );

    expect(out.kind).toBe("approved");
    expect(ran).toEqual([`${PAL}:ask one more thing`]); // as the pal, not the approver
    expect(posts.some((p) => p.channel === "C1" && p.text === "did the thing" && p.threadTs === "9.9")).toBe(true);
    expect(deps.commandApprovals!.listPending()).toHaveLength(0);
  });

  test("rejecting tells them and runs nothing", async () => {
    const { deps, posts, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    await dispatchCommand(deps, actor(), "C1", "ask one more thing");
    const held = deps.commandApprovals!.listPending()[0]!;

    let ran = false;
    const out = await decideCommandApproval(
      deps,
      { slackUserId: OWNER, actionId: REJECT_ACTION, value: String(held.id) },
      async () => {
        ran = true;
        return "";
      },
    );

    expect(out.kind).toBe("rejected");
    expect(ran).toBe(false);
    expect(posts.some((p) => p.channel === "C1" && p.text.includes("not approved"))).toBe(true);
  });

  test("only owner and admin can press the buttons", async () => {
    const { deps, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    await dispatchCommand(deps, actor(), "C1", "ask one more thing");
    const held = deps.commandApprovals!.listPending()[0]!;

    for (const clicker of [PAL, "U0STRANGE"]) {
      const out = await decideCommandApproval(
        deps,
        { slackUserId: clicker, actionId: APPROVE_ACTION, value: String(held.id) },
        async () => "should not run",
      );
      expect(out).toEqual({ kind: "ignored", reason: "not-allowed" });
    }
    // an admin may
    const ok = await decideCommandApproval(
      deps,
      { slackUserId: "U0ADMIN01", actionId: APPROVE_ACTION, value: String(held.id) },
      async () => "ran",
    );
    expect(ok.kind).toBe("approved");
  });

  test("a second press does nothing - approval cannot be undone by a later reject", async () => {
    const { deps, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    await dispatchCommand(deps, actor(), "C1", "ask one more thing");
    const held = deps.commandApprovals!.listPending()[0]!;

    let runs = 0;
    const press = (actionId: string) =>
      decideCommandApproval(deps, { slackUserId: OWNER, actionId, value: String(held.id) }, async () => {
        runs += 1;
        return "ran";
      });

    expect((await press(APPROVE_ACTION)).kind).toBe("approved");
    expect(await press(REJECT_ACTION)).toEqual({ kind: "ignored", reason: "already-decided" });
    expect(runs).toBe(1);
  });

  test("an approved command is not re-counted against the allowance", async () => {
    const { deps, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    await dispatchCommand(deps, actor(), "C1", "ask one more thing");
    const held = deps.commandApprovals!.listPending()[0]!;

    // running it pre-approved must not be held again
    const out = await dispatchCommand(deps, actor(), "C1", held.line, { preApproved: true });
    expect(out).toBe("an answer");
  });
});

describe("admins setting an allowance", () => {
  const owner = actor({ slackId: OWNER, role: "owner" });
  const admin = actor({ slackId: "U0ADMIN01", role: "admin" });

  test("an admin raises someone's allowance and it takes effect", async () => {
    const { deps, spend } = build();
    await spend(PAL_COMMAND_LIMIT);
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS).limited).toBe(true);

    const out = await dispatchCommand(deps, admin, "C1", `limit <@${PAL}> 25`);
    expect(out).toContain("25");
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS)).toMatchObject({ limited: false, limit: 25 });
  });

  test("zero means every command needs approval", async () => {
    const { deps } = build();
    await dispatchCommand(deps, owner, "C1", `limit <@${PAL}> 0`);
    expect(allowanceFor(deps, actor(), TRIVIAL_COMMANDS).limited).toBe(true);

    const out = await dispatchCommand(deps, actor(), "C1", "ask anything");
    expect(out).toContain("hit your limit");
  });

  test("default puts them back", async () => {
    const { deps } = build();
    await dispatchCommand(deps, admin, "C1", `limit <@${PAL}> 3`);
    expect(limitFor(deps, PAL)).toBe(3);

    await dispatchCommand(deps, admin, "C1", `limit <@${PAL}> default`);
    expect(limitFor(deps, PAL)).toBe(PAL_COMMAND_LIMIT);
  });

  test("a pal sees their own standing but cannot change anything", async () => {
    const { deps, spend } = build();
    await spend(3);

    const own = await dispatchCommand(deps, actor(), "C1", "limit");
    expect(own).toContain("3/10");

    expect(await dispatchCommand(deps, actor(), "C1", `limit <@${PAL}> 99`)).toContain("Only admins");
    expect(await dispatchCommand(deps, actor(), "C1", `limit <@U0ADMIN01>`)).toContain("Only admins");
    expect(limitFor(deps, PAL)).toBe(PAL_COMMAND_LIMIT);
  });

  test("an unlimited role is reported as such, not as 0/10", async () => {
    const { deps } = build();
    expect(await dispatchCommand(deps, admin, "C1", `limit <@${OWNER}>`)).toContain("no allowance applies");
  });

  test("a nonsense number is refused rather than silently ignored", async () => {
    const { deps } = build();
    expect(await dispatchCommand(deps, admin, "C1", `limit <@${PAL}> lots`)).toContain("How many?");
    expect(limitFor(deps, PAL)).toBe(PAL_COMMAND_LIMIT);
  });
});
