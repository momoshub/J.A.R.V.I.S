import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import type { InteractiveMenu, SlackAdminPort } from "../../src/application/slackAdmin.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import { MENU_SELECT_ACTION, menuRunActionId } from "../../src/domain/commandMenu.ts";
import type { SystemReading } from "../../src/domain/systemStatus.ts";

const OWNER = "U0OWNER";
const actor = (role: AllowedUser["role"] = "owner"): AllowedUser => ({
  slackId: OWNER,
  role,
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
});

type Posted = { channel: string; text: string; menu: InteractiveMenu; threadTs?: string };

const fakeSlack = (posted: Posted[], fail = false): SlackAdminPort =>
  ({
    postMenu: async (channel: string, text: string, menu: InteractiveMenu, threadTs?: string) => {
      if (fail) throw new Error("no interactivity here");
      posted.push({ channel, text, menu, threadTs });
      return { channel, ts: "1.0" };
    },
  }) as unknown as SlackAdminPort;

const GB = 1024 ** 3;
const reading: SystemReading = {
  at: 1_700_000_000_000,
  cores: 8,
  load1: 1,
  load5: 1,
  load15: 1,
  memTotal: 16 * GB,
  memAvailable: 12 * GB,
  memSource: "pressure",
  hostUptimeS: 7_200,
  procRss: 100 * 1024 ** 2,
  procUptimeS: 600,
  socket: "connected",
  activeRuns: 0,
};

const deps = (over: Partial<CommandDeps> = {}): CommandDeps => {
  const db = openDatabase(":memory:");
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    ownerSlackId: OWNER,
    clock: () => 1_700_000_000_000,
    ...over,
  };
};

/** A person typing it: `respond` wires a reply, so a menu is worth posting. */
const run = (d: CommandDeps, line: string, who = actor()) =>
  dispatchCommand(d, who, "C1", line, {
    prefix: "X/jv",
    slash: "/jv",
    threadTs: "99.1",
    reply: async () => {},
  });

/** The brain asking itself what it can run: no reply, nothing posted. */
const runQuiet = (d: CommandDeps, line: string, who = actor()) =>
  dispatchCommand(d, who, "C1", line, { prefix: "X/jv", slash: "/jv", threadTs: "99.1" });

describe("help as a menu", () => {
  test("it posts the full list AND a picker, in that order", async () => {
    const posted: Posted[] = [];
    const out = await run(deps({ slack: fakeSlack(posted) }), "help");

    expect(posted.length).toBe(1);
    const text = posted[0]?.text ?? "";
    // the list is still what you read to find out what exists, or to copy a
    // command out of - the picker is the convenient path, not the only one
    expect(text).toContain("Commands - run either way");
    expect(text).toContain("`ping`");
    expect(text).toContain("`whoami`");
    // and the controls come last
    expect(text.indexOf("Or pick one here")).toBeGreaterThan(text.indexOf("`ping`"));
    expect(posted[0]?.menu.select?.actionId).toBe(MENU_SELECT_ACTION);
    // nothing returned, so the transport does not post the list a second time
    expect(out).toBe("");
  });

  test("it answers in the thread it was asked from", async () => {
    const posted: Posted[] = [];
    await run(deps({ slack: fakeSlack(posted) }), "help");
    expect(posted[0]?.threadTs).toBe("99.1");
  });

  test("the picker only offers what the asker may run", async () => {
    const posted: Posted[] = [];
    await run(deps({ slack: fakeSlack(posted) }), "help", actor("pal"));
    const names = posted[0]?.menu.select?.groups.flatMap((g) => g.options.map((o) => o.value)) ?? [];

    expect(names).toContain("ping");
    expect(names).not.toContain("learn");
    expect(names).not.toContain("sys");
  });

  test("quick buttons are real commands that need no arguments", async () => {
    const posted: Posted[] = [];
    await run(deps({ slack: fakeSlack(posted) }), "help");
    const buttons = posted[0]?.menu.actions ?? [];

    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.map((b) => b.value)).toContain("ping");
    // Slack rejects a block whose buttons share an action_id, and only when it
    // is posted - so the ids must be distinct and carry the command.
    const ids = buttons.map((b) => b.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(menuRunActionId("ping"));
  });

  test("`menu` is the same thing, because that is what it is now", async () => {
    const posted: Posted[] = [];
    await run(deps({ slack: fakeSlack(posted) }), "menu");
    expect(posted.length).toBe(1);
  });

  test("the brain gets the list back and posts NOTHING", async () => {
    // it is told never to read its own source to find out what it can do, so
    // it runs `help` - and the whole command list landed in the middle of a
    // conversation, twice, with a stray pong after it
    const posted: Posted[] = [];
    const out = await runQuiet(deps({ slack: fakeSlack(posted) }), "help");

    expect(posted.length).toBe(0);
    expect(out).toContain("ping");
  });

  test("help is a quiet command", async () => {
    const { isQuietCommand } = await import("../../src/application/commands.ts");
    expect(isQuietCommand("help")).toBe(true);
    expect(isQuietCommand("ping")).toBe(true);
    expect(isQuietCommand("whoami")).toBe(true);
  });

  test("with no Slack to post into, the plain list still works", async () => {
    const out = await run(deps(), "help");
    expect(out).toContain("Commands");
    expect(out).toContain("ping");
  });

  test("and if posting the menu fails, it falls back rather than erroring", async () => {
    // help that fails is worse than help that is merely old-fashioned
    const out = await run(deps({ slack: fakeSlack([], true) }), "help");
    expect(out).toContain("ping");
  });
});

describe("sys", () => {
  test("it reports the host, leading with the verdict", async () => {
    const d = deps({
      system: { read: async () => reading, history: () => [reading], stop: () => {} },
      botInfo: () => ({ botName: "Jarvis", model: "opus" }),
    });
    const out = await run(d, "sys");

    expect(out).toContain("nothing abnormal");
    expect(out).toContain("*cpu*");
    expect(out).toContain("*memory*");
  });

  test("it says so rather than inventing numbers when it cannot read the host", async () => {
    expect(await run(deps(), "sys")).toContain("cannot read the system");
  });

  test("a pal cannot read the machine the bot runs on", async () => {
    const d = deps({ system: { read: async () => reading, history: () => [], stop: () => {} } });
    expect(await run(d, "sys", actor("pal"))).toContain("admin");
  });
});
