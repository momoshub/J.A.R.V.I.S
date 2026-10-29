import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createSettingsRepo } from "../../src/infrastructure/db/settingsRepo.ts";
import { SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { dispatchCommand, type CommandDeps } from "../../src/application/commands.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import type { LlmPort } from "../../src/application/ports.ts";

const OWNER = "U0OWNER";
const actor = (role: AllowedUser["role"] = "owner"): AllowedUser => ({
  slackId: OWNER,
  role,
  displayName: "Kai",
  addedBy: "system",
  createdAt: 0,
});

const deps = (over: Partial<CommandDeps> = {}): CommandDeps => {
  const db = openDatabase(":memory:");
  return {
    users: createUserRepo(db),
    messages: createMessageRepo(db),
    settings: createSettingsRepo(db),
    ownerSlackId: OWNER,
    clock: () => 0,
    ...over,
  };
};

const run = (d: CommandDeps, line: string, who = actor()) =>
  dispatchCommand(d, who, "C1", line, { prefix: "X/jv" });

describe("note", () => {
  test("with nowhere configured it says so, and how to fix it", async () => {
    expect(await run(deps(), "note /tmp/x.md")).toContain("note parent");
  });

  test("an admin sets where pages go", async () => {
    const d = deps();
    const out = await run(d, "note parent https://notion.so/team");
    expect(out).toContain("https://notion.so/team");
    expect(d.settings?.get(SETTING_KEYS.notionParent)).toBe("https://notion.so/team");
  });

  test("it publishes on the HOST login - a setup token carries no connectors", async () => {
    const seen: { useHostLogin?: boolean; system?: string }[] = [];
    const llm: LlmPort = {
      complete: async (p) => {
        seen.push({ useHostLogin: (p as { useHostLogin?: boolean }).useHostLogin, system: p.system });
        return "https://notion.so/new-page";
      },
    };
    const d = deps({ llm });
    d.settings?.set(SETTING_KEYS.notionParent, "https://notion.so/team");

    const out = await run(d, "note /tmp/runbook.md CPV2 runbook");
    expect(out).toContain("https://notion.so/new-page");
    expect(seen[0]?.useHostLogin).toBe(true);
    expect(seen[0]?.system).toContain("/tmp/runbook.md");
    expect(seen[0]?.system).toContain("Title: CPV2 runbook");
  });

  test("publishing under someone else's identity is gated, and names who can", async () => {
    const d = deps();
    d.settings?.set(SETTING_KEYS.notionParent, "https://notion.so/team");
    const out = await run(d, "note /tmp/x.md", actor("pal"));
    expect(out).toContain("admin");
  });

  test("the floor is a setting, like read's", async () => {
    const d = deps();
    d.settings?.set(SETTING_KEYS.notionParent, "https://notion.so/team");
    await run(d, "note access executer");
    expect(d.settings?.get(SETTING_KEYS.noteMinRole)).toBe("executer");
  });

  test("it is a tool, so the brain gets the url back instead of posting it", async () => {
    const { isQuietCommand } = await import("../../src/application/commands.ts");
    expect(isQuietCommand("note /tmp/x.md")).toBe(true);
  });
});

describe("close", () => {
  test("it refuses without a tracker configured", async () => {
    expect(await run(deps(), "close GEN-1 because reasons")).toContain("which pages are ours to close");
  });

  test("a close with no reason is refused", async () => {
    const d = deps();
    d.settings?.set(SETTING_KEYS.ticketTracker, "https://notion.so/t");
    expect(await run(d, "close GEN-1")).toContain("same as one by accident");
  });

  test("it runs on the HOST login and carries the tracker", async () => {
    const seen: { useHostLogin?: boolean; system?: string }[] = [];
    const llm: LlmPort = {
      complete: async (p) => {
        seen.push({ useHostLogin: (p as { useHostLogin?: boolean }).useHostLogin, system: p.system });
        return "GEN-1 -> Obsolete";
      },
    };
    const d = deps({ llm });
    d.settings?.set(SETTING_KEYS.ticketTracker, "https://notion.so/t");

    const out = await run(d, "close GEN-1 safe as deployed");
    expect(out).toContain("Obsolete");
    expect(seen[0]?.useHostLogin).toBe(true);
    expect(seen[0]?.system).toContain("https://notion.so/t");
    expect(seen[0]?.system).toContain("safe as deployed");
  });

  test("closing the team's tracker is an admin act", async () => {
    const d = deps();
    d.settings?.set(SETTING_KEYS.ticketTracker, "https://notion.so/t");
    expect(await run(d, "close GEN-1 why", actor("executer"))).toContain("admin");
  });
});
