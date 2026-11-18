import { describe, expect, test } from "bun:test";
import { dispatchCommand } from "../../src/application/commands.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { parseExtraMethods } from "../../src/domain/slackProxy.ts";
import { OWNER, actor, build, db } from "./commandsFixture.ts";

const setup = () => {
  const deps = build();
  const settings = createSettingsRepo(db);
  deps.settings = settings;
  const stored = () => parseExtraMethods(settings.get(SETTING_KEYS.slackExtraMethods));
  const run = (line: string, who = actor()) => dispatchCommand(deps, who, "D0SRC", `slack-methods ${line}`.trim());
  return { deps, run, stored };
};

describe("slack-methods command", () => {
  test("adds a write with the default channel param, and lists it", async () => {
    const { run, stored } = setup();
    expect(await run("add conversations.setTopic write")).toContain("Added");
    expect(await run("add conversations.setPurpose write channel")).toContain("Added");
    expect(stored()).toEqual([
      { method: "conversations.setTopic", kind: "write", channelParam: "channel" },
      { method: "conversations.setPurpose", kind: "write", channelParam: "channel" },
    ]);
    const list = await run("list");
    expect(list).toContain("conversations.setTopic");
    expect(list).toContain("chat.postMessage");
  });

  test("a bare `slack-methods` lists", async () => {
    const { run } = setup();
    expect(await run("")).toContain("Added by the owner");
  });

  test("adds a read, which takes no channel param", async () => {
    const { run, stored } = setup();
    expect(await run("add users.list read")).toContain("Added");
    expect(stored()).toEqual([{ method: "users.list", kind: "read" }]);
    expect(await run("add users.conversations read channel")).toContain("no channel parameter");
  });

  test("adding the same method again updates it instead of duplicating", async () => {
    const { run, stored } = setup();
    await run("add conversations.mark write channel");
    expect(await run("add conversations.mark write channel_id")).toContain("Updated");
    expect(stored()).toEqual([{ method: "conversations.mark", kind: "write", channelParam: "channel_id" }]);
  });

  test("refuses token and admin families, bad names, built-ins and a bad kind; nothing is stored", async () => {
    const { run, stored } = setup();
    for (const line of ["add auth.test read", "add admin.teams write", "add apps.uninstall write", "add oauth.access read", "add conversations.set.Topic write", "add setTopic write", "add users.info read", "add chat.postMessage write"]) {
      expect(await run(line)).toContain("Not added");
    }
    expect(await run("add users.list sideways")).toContain("reads or writes");
    expect(await run("add conversations.mark write Bad-Param")).toContain("not a parameter name");
    expect(stored()).toEqual([]);
  });

  test("removes an added method, refuses a built-in, and says so for an unknown one", async () => {
    const { run, stored } = setup();
    await run("add conversations.setTopic write");
    expect(await run("remove chat.postMessage")).toContain("built in");
    expect(await run("remove users.list")).toContain("not one of the added");
    expect(await run("remove conversations.setTopic")).toContain("Removed");
    expect(stored()).toEqual([]);
  });

  test("only the owner may run it", async () => {
    const { run, stored } = setup();
    const admin = actor({ slackId: "U0ADMIN0001", role: "admin" });
    expect(await run("add users.list read", admin)).toContain("needs *owner* access");
    expect(stored()).toEqual([]);
    expect(actor().slackId).toBe(OWNER);
  });

  test("help names the refused families and the scope", async () => {
    const { run } = setup();
    const help = await run("help");
    expect(help).toContain("auth.*");
    expect(help).toContain("admin.*");
    expect(help).toContain("channels:manage");
  });

  test("without settings it says so instead of throwing", async () => {
    const deps = build();
    expect(await dispatchCommand(deps, actor(), "D0SRC", "slack-methods add users.list read")).toContain("Settings are not available");
  });
});
