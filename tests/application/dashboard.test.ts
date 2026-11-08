import { describe, expect, test } from "bun:test";
import { createDashboardService, usageWindowMs, type DashboardPorts, type MemoryAdapterPort } from "../../src/application/dashboard.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import { SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { createNameResolver } from "../../src/application/nameResolver.ts";
import { ROLES, defaultRolePolicy, type RolePolicy } from "../../src/domain/rolePolicy.ts";
import type { UserRole } from "../../src/domain/types.ts";

const OWNER = "UOWNER1";

/** In-memory ports: the use cases need nothing but these shapes. */
const ports = (over: Partial<DashboardPorts> = {}) => {
  const users = new Map<string, AllowedUser>();
  const settings = new Map<string, string>();
  const learnings: { id: number; content: string; createdBy: string }[] = [];
  const cleared: string[] = [];
  const p: DashboardPorts = {
    ownerSlackId: OWNER,
    clock: () => 1_000_000,
    profile: () => ({ name: "Bot", thinkingLabel: "thinking", thinkingDoneLabel: "done" }) as ReturnType<DashboardPorts["profile"]>,
    users: {
      get: (id) => users.get(id),
      list: () => [...users.values()],
      upsert: (u) => users.set(u.slackId, u),
      setDisplayName: (id, displayName) => {
        const u = users.get(id);
        if (u) users.set(id, { ...u, displayName });
      },
      rename: (from, to) => {
        const u = users.get(from);
        if (!u || users.has(to)) return false;
        users.delete(from);
        users.set(to, { ...u, slackId: to });
        return true;
      },
      remove: (id) => void users.delete(id),
    },
    messages: {
      channels: () => [{ channelId: "C1" }],
      count: () => 3,
      channelsPage: () => ({ channels: [{ channelId: "C1" }] }),
      pageForChannel: (c, _before, limit) => ({ messages: [{ slackUserId: `U-${c}-${limit}`, content: "hi" }] }),
      countForChannel: () => 1,
      clearChannel: (c) => cleared.push(c),
    },
    learnings: {
      list: () => learnings,
      add: (content, createdBy) => learnings.push({ id: learnings.length + 1, content, createdBy }),
      update: (id, content) => {
        const l = learnings.find((x) => x.id === id);
        if (l) l.content = content;
      },
      remove: (id) => void learnings.splice(learnings.findIndex((x) => x.id === id), 1),
    },
    settings: {
      get: (k) => settings.get(k),
      set: (k, v) => void settings.set(k, v),
      remove: (k) => void settings.delete(k),
      list: () => [...settings].map(([key, value]) => ({ key, value })),
    },
    ...over,
  };
  return { p, users, settings, learnings, cleared, app: createDashboardService(p) };
};

const adapter = (over: Partial<MemoryAdapterPort> = {}): MemoryAdapterPort => ({
  status: () => "ok",
  view: () => ({ policy: "", notes: "", skills: [], people: [], channels: [], revisions: [], items: 7 }),
  remember: () => ({ ok: true, warnings: ["w"] }),
  revert: () => ({ ok: true }),
  files: () => [{ path: "a.md", content: "x" }],
  edit: () => ({ ok: true }),
  ...over,
});

describe("dashboard use cases", () => {
  test("saveUser refuses a bad id and the owner, keeps name and date on update", () => {
    const { app, users } = ports();
    expect(app.saveUser("nope", "admin")).toEqual({ ok: false, error: "Invalid Slack id", status: 400 });
    expect(app.saveUser(OWNER, "pal").ok).toBe(false);
    users.set("U1", { slackId: "U1", role: "pal", displayName: "Ann", addedBy: "x", createdAt: 5 });
    expect(app.saveUser(" U1 ", "admin").ok).toBe(true);
    expect(users.get("U1")).toEqual({ slackId: "U1", role: "admin", displayName: "Ann", addedBy: "dashboard", createdAt: 5 });
    // Bad input is refused, never quietly turned into pal.
    expect(app.saveUser("U2", "owner")).toEqual({ ok: false, error: "Pick admin, executer or pal", status: 400 });
    expect(users.has("U2")).toBe(false);
  });

  test("removeUser never removes the owner", () => {
    const { app } = ports();
    expect(app.removeUser(OWNER)).toEqual({ ok: false, error: "The owner cannot be removed", status: 400 });
    expect(app.removeUser("U9").ok).toBe(true);
  });

  test("listUsers fills names from Slack only where none is stored, and survives a failed lookup", async () => {
    const asked: string[][] = [];
    const { app, users } = ports({
      resolveNames: async (ids) => {
        asked.push([...ids]);
        return { U2: "Bea" };
      },
    });
    users.set("U1", { slackId: "U1", role: "pal", displayName: "Ann", addedBy: "x", createdAt: 1 });
    users.set("U2", { slackId: "U2", role: "pal", displayName: "", addedBy: "x", createdAt: 1 });
    expect((await app.listUsers()).map((u) => u.name)).toEqual(["Ann", "Bea"]);
    expect(asked).toEqual([["U2"]]);
    const failing = ports({ resolveNames: () => Promise.reject(new Error("down")) });
    failing.users.set("U2", { slackId: "U2", role: "pal", displayName: "", addedBy: "x", createdAt: 1 });
    expect((await failing.app.listUsers())[0]?.name).toBe("");
  });

  test("teach writes to the adapter when there is one, the table otherwise", () => {
    const plain = ports();
    expect(plain.app.teach("  ").ok).toBe(false);
    expect(plain.app.teach(" a fact ")).toEqual({ ok: true, value: {} });
    expect(plain.learnings[0]).toMatchObject({ content: "a fact", createdBy: "dashboard" });

    const said: string[] = [];
    const withAdapter = ports({ adapter: adapter({ remember: (c) => (said.push(c), { ok: true, warnings: ["w"] }) }) });
    expect(withAdapter.app.teach("x")).toEqual({ ok: true, value: { warnings: ["w"] } });
    expect(said).toEqual(["x"]);
    expect(withAdapter.learnings).toEqual([]);

    const refused = ports({ adapter: adapter({ remember: () => ({ ok: false, violations: ["a", "b"] }) }) });
    expect(refused.app.teach("x")).toEqual({ ok: false, error: "a; b", status: 400 });
  });

  test("overview counts adapter items instead of the empty table", () => {
    expect(ports().app.overview()).toMatchObject({ learnings: 0, memory: false, messages: 3, conversations: 1 });
    expect(ports({ adapter: adapter() }).app.overview()).toMatchObject({ learnings: 7, memory: true });
  });

  test("adapter use cases refuse without an adapter and pass base through", () => {
    const none = ports().app;
    expect(none.adapterFiles()).toEqual({ ok: false, error: "No memory adapter is configured", status: 404 });
    expect(none.revertAdapter(1).ok).toBe(false);
    expect(none.adapterView()).toEqual({ configured: false });

    const bases: (string | undefined)[] = [];
    const app = ports({ adapter: adapter({ edit: (_p, _c, _b, base) => (bases.push(base), { ok: true }) }) }).app;
    expect(app.editAdapterFile("", "x", "").ok).toBe(false);
    expect(app.editAdapterFile("a.md", 5, "").ok).toBe(false);
    expect(app.editAdapterFile("a.md", "", "old")).toEqual({ ok: true, value: { warnings: [] } });
    app.editAdapterFile("a.md", "y", 3);
    expect(bases).toEqual(["old", undefined]);
    expect(app.revertAdapter("x")).toEqual({ ok: false, error: "A revision id is required", status: 400 });
  });

  test("saveIdentity requires a name, clears blank labels, keeps the prompt when blank", () => {
    const { app, settings } = ports();
    expect(app.saveIdentity({ name: " ", thinkingLabel: "", thinkingDoneLabel: "", prompt: "" }).ok).toBe(false);
    settings.set(SETTING_KEYS.thinkingLabel, "old");
    settings.set(SETTING_KEYS.systemPrompt, "kept");
    app.saveIdentity({ name: "Jay", thinkingLabel: " ", thinkingDoneLabel: "fin", prompt: "" });
    expect(settings.get(SETTING_KEYS.botName)).toBe("Jay");
    expect(settings.has(SETTING_KEYS.thinkingLabel)).toBe(false);
    expect(settings.get(SETTING_KEYS.thinkingDoneLabel)).toBe("fin");
    expect(settings.get(SETTING_KEYS.systemPrompt)).toBe("kept");
    expect(app.identity()).toMatchObject({ persona: "kept", usingDefault: false });
    app.resetPrompt();
    expect(app.identity().usingDefault).toBe(true);
  });

  test("toggleCommand keeps the disabled list as csv", () => {
    const { app, settings } = ports();
    expect(app.toggleCommand("", false).ok).toBe(false);
    app.toggleCommand("bomb", false);
    app.toggleCommand("review", false);
    app.toggleCommand("bomb", true);
    expect(settings.get(SETTING_KEYS.disabledCommands)).toBe("review");
    expect(app.commands().disabled).toEqual(["review"]);
  });

  test("conversations page with a clamped size and ignore a blank channel on clear", async () => {
    const { app, cleared } = ports();
    expect((await app.conversation("")).messages).toEqual([]);
    expect((await app.conversation("C1")).messages).toEqual([
      { slackUserId: "U-C1-50", content: "hi", userLabel: "unknown (U-C1-50)" },
    ]);
    expect((await app.conversation("C1", null, "9999")).messages[0]?.slackUserId).toBe("U-C1-200");
    expect((await app.conversation("C1", "abc", "nope")).messages[0]?.slackUserId).toBe("U-C1-50");
    app.clearConversation("  ");
    app.clearConversation(" C1 ");
    expect(cleared).toEqual(["C1"]);
  });

  test("usage reports not recording without a store, and clamps its window", async () => {
    expect(await ports().app.usage("24")).toEqual({ recording: false });
    expect(usageWindowMs(null)).toBe(24 * 3_600_000);
    expect(usageWindowMs("-1")).toBe(24 * 3_600_000);
    expect(usageWindowMs("abc")).toBe(24 * 3_600_000);
    expect(usageWindowMs("99999")).toBe(24 * 365 * 3_600_000);
  });

  test("saveKitView needs the store and a valid view", () => {
    expect(ports().app.saveKitView({}).ok).toBe(false);
    const app = ports({ kitViews: { save: () => "abc" } }).app;
    expect(app.saveKitView({ nope: true }).ok).toBe(false);
  });

  test("saveUser hands out executer too, never owner", () => {
    const { app, users } = ports();
    app.saveUser("U3", "executer");
    expect(users.get("U3")?.role).toBe("executer");
  });
});

const policyStore = () => {
  const rows = new Map<UserRole, RolePolicy>();
  return {
    rows,
    port: {
      list: () => ROLES.map((r) => rows.get(r) ?? defaultRolePolicy(r)),
      save: (p: RolePolicy) => void rows.set(p.role, p),
    },
  };
};

describe("dashboard roles", () => {
  test("roles lists every role with members, and offers only commands within its rank", () => {
    const store = policyStore();
    const { app, users } = ports({ rolePolicies: store.port });
    users.set(OWNER, { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
    users.set("U1", { slackId: "U1", role: "pal", displayName: "Ann", addedBy: "x", createdAt: 1 });
    const view = app.roles();
    expect(view.roles.map((r) => r.role)).toEqual(["owner", "admin", "executer", "pal"]);
    const owner = view.roles.find((r) => r.role === "owner")!;
    const pal = view.roles.find((r) => r.role === "pal")!;
    expect(owner.locked).toBe(true);
    expect(owner.members).toEqual([{ slackId: OWNER, name: "Kai" }]);
    expect(pal.members).toEqual([{ slackId: "U1", name: "Ann" }]);
    // `tell` is admin+: nothing to tick for a pal. `help` can never be denied.
    expect(pal.commands).not.toContain("tell");
    expect(pal.commands).not.toContain("help");
    expect(owner.commands).toContain("tell");
    expect(view.tools).toContain("Bash");
    expect(view.mcpServers).toContain("pg-prod");
    expect(view.editable).toBe(true);
  });

  test("saveRolePolicy persists through the port and refuses the owner and unknown names", () => {
    const store = policyStore();
    const { app } = ports({ rolePolicies: store.port });
    const save = (over: Record<string, unknown>) =>
      app.saveRolePolicy({ role: "pal", enabled: true, deniedCommands: [], deniedTools: [], deniedMcpServers: [], ...over });
    expect(save({ role: "owner", enabled: false }).ok).toBe(false);
    expect(save({ deniedCommands: ["nope-not-a-command"] }).ok).toBe(false);
    expect(save({ deniedTools: ["rm -rf /"] }).ok).toBe(false);
    expect(save({ enabled: false, deniedCommands: ["ping"], deniedTools: ["Bash"], deniedMcpServers: ["mcp__notion"] }).ok).toBe(true);
    expect(store.rows.get("pal")).toEqual({
      role: "pal",
      enabled: false,
      deniedCommands: ["ping"],
      deniedTools: ["Bash"],
      deniedMcpServers: ["notion"],
    });
    expect(app.roles().roles.find((r) => r.role === "pal")?.enabled).toBe(false);
    // Without a store nothing can be saved, and roles still read as defaults.
    expect(ports().app.saveRolePolicy({ role: "pal", enabled: false, deniedCommands: [], deniedTools: [], deniedMcpServers: [] }).ok).toBe(false);
    expect(ports().app.roles().editable).toBe(false);
  });

  test("assignRole moves an existing user, never the owner and never into owner", () => {
    const { app, users } = ports();
    users.set("U1", { slackId: "U1", role: "pal", displayName: "Ann", addedBy: "x", createdAt: 1 });
    users.set(OWNER, { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
    expect(app.assignRole("U1", "executer").ok).toBe(true);
    expect(users.get("U1")?.role).toBe("executer");
    expect(app.assignRole("U1", "owner").ok).toBe(false);
    expect(app.assignRole(OWNER, "pal").ok).toBe(false);
    expect(app.assignRole("U404", "pal")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("dashboard user edits", () => {
  const seeded = () => {
    const env = ports();
    env.users.set(OWNER, { slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
    env.users.set("U1", { slackId: "U1", role: "pal", displayName: "Ann", addedBy: "x", createdAt: 1 });
    env.users.set("U2", { slackId: "U2", role: "pal", displayName: "Bea", addedBy: "x", createdAt: 1 });
    return env;
  };

  test("edits name, GitHub logins and role, through the same github_login links the bot reads", async () => {
    const { app, users, settings } = seeded();
    settings.set("github_login:old-ann", "U1");
    expect(app.updateUser({ slackId: "U1", displayName: " Annie ", githubLogins: "@Ann-GH, ann2", role: "executer" }).ok).toBe(true);
    expect(users.get("U1")).toMatchObject({ displayName: "Annie", role: "executer" });
    expect(settings.has("github_login:old-ann")).toBe(false);
    expect(settings.get("github_login:ann-gh")).toBe("U1");
    expect(settings.get("github_login:ann2")).toBe("U1");
    expect((await app.listUsers()).find((u) => u.slackId === "U1")?.githubLogins).toEqual(["ann-gh", "ann2"]);
  });

  test("a corrected Slack id moves the record and its GitHub links", () => {
    const { app, users, settings } = seeded();
    settings.set("github_login:ann", "U1");
    expect(app.updateUser({ slackId: "U1", newSlackId: "U9" }).ok).toBe(true);
    expect(users.has("U1")).toBe(false);
    expect(users.get("U9")?.displayName).toBe("Ann");
    expect(settings.get("github_login:ann")).toBe("U9");
  });

  test("refuses collisions, bad input, and any change to the owner's id or role", () => {
    const { app, settings } = seeded();
    settings.set("github_login:bea", "U2");
    expect(app.updateUser({ slackId: "U1", newSlackId: "U2" }).ok).toBe(false);
    expect(app.updateUser({ slackId: "U1", newSlackId: OWNER }).ok).toBe(false);
    expect(app.updateUser({ slackId: "U1", newSlackId: "nope" }).ok).toBe(false);
    expect(app.updateUser({ slackId: "U1", githubLogins: "bad login!" }).ok).toBe(false);
    const taken = app.updateUser({ slackId: "U1", githubLogins: "bea" });
    expect(taken).toMatchObject({ ok: false, error: "bea is already linked to Bea (U2)" });
    expect(app.updateUser({ slackId: "U1", role: "owner" })).toMatchObject({ ok: false, error: "Pick admin, executer or pal" });
    expect(app.updateUser({ slackId: "U1", role: "admn" }).ok).toBe(false);
    expect(app.updateUser({ slackId: OWNER, newSlackId: "U7" }).ok).toBe(false);
    expect(app.updateUser({ slackId: OWNER, role: "pal" }).ok).toBe(false);
    expect(app.updateUser({ slackId: OWNER, displayName: "Kai K", githubLogins: "kai" }).ok).toBe(true);
    expect(app.updateUser({ slackId: "U404", displayName: "x" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("dashboard GitHub links", () => {
  test("removing a user drops their links, and a link held by a non-member is free to take", () => {
    const { app, users, settings } = ports();
    users.set("U1", { slackId: "U1", role: "pal", displayName: "Ann", addedBy: "x", createdAt: 1 });
    users.set("U2", { slackId: "U2", role: "pal", displayName: "Bea", addedBy: "x", createdAt: 1 });
    settings.set("github_login:bea", "U2");
    settings.set("github_login:ghost", "UGONE");
    expect(app.removeUser("U2").ok).toBe(true);
    expect(settings.has("github_login:bea")).toBe(false);
    expect(app.updateUser({ slackId: "U1", githubLogins: "bea, ghost" }).ok).toBe(true);
    expect(settings.get("github_login:ghost")).toBe("U1");
    expect(settings.get("github_login:bea")).toBe("U1");
  });
});

describe("dashboard names", () => {
  test("conversations, their turns, the command log and spend never show a bare id", async () => {
    const names = createNameResolver({
      clock: () => 0,
      lookups: {
        conversation: async (id) =>
          id === "C1" ? { kind: "channel", name: "team-chat" } : id === "D1" ? { kind: "im", userId: "U2" } : undefined,
        users: async (ids) => Object.fromEntries(ids.map((id) => [id, id === "U2" ? "Bea" : id])),
      },
    });
    const { app } = ports({
      names,
      messages: {
        channels: () => [{ channelId: "C1" }, { channelId: "D1" }],
        count: () => 0,
        channelsPage: () => ({ channels: [{ channelId: "C1" }, { channelId: "D1" }] }),
        pageForChannel: () => ({
          messages: [
            { slackUserId: "U2", content: "ask <@U3|old> about it" },
            { slackUserId: "U3", content: "ok" },
          ],
        }),
        countForChannel: () => 2,
        clearChannel: () => undefined,
      },
      commandLog: { recent: () => [{ slackUserId: "U2", channelId: "D1" }], clear: () => undefined },
      usage: { totals: () => ({}), byUser: () => [{ key: "U2" }], byKind: () => [] },
    });
    expect((await app.conversations()).channels.map((c) => c.label)).toEqual(["#team-chat (C1)", "@Bea (D1)"]);
    const convo = await app.conversation("C1");
    expect(convo.channel.label).toBe("#team-chat (C1)");
    expect(convo.messages.map((m) => m.userLabel)).toEqual(["Bea (U2)", "unknown (U3)"]);
    expect(convo.messages[0]?.content).toBe("ask @unknown (U3) about it");
    expect(await app.commandLog()).toEqual([
      { slackUserId: "U2", channelId: "D1", userLabel: "Bea (U2)", channelLabel: "@Bea (D1)" },
    ]);
    expect(await app.usage("1")).toMatchObject({ names: { U2: "Bea (U2)" } });
  });
});

describe("conversation cursors", () => {
  test("passes the cursor through and returns the next one", async () => {
    const seen: unknown[] = [];
    const { app } = ports({
      messages: {
        channels: () => [],
        count: () => 0,
        channelsPage: (cursor, limit) => {
          seen.push(["channels", cursor, limit]);
          return { channels: [{ channelId: "C1" }], nextCursor: "5:C1" };
        },
        pageForChannel: (c, before, limit) => {
          seen.push(["page", c, before, limit]);
          return { messages: [{ slackUserId: "U1", content: "x" }], nextBefore: 7 };
        },
        countForChannel: () => 42,
        clearChannel: () => undefined,
      },
    });
    expect(await app.conversations("9:C2", "10")).toMatchObject({ nextCursor: "5:C1", channels: [{ channelId: "C1" }] });
    expect(await app.conversation("C1", "12", null)).toMatchObject({ nextBefore: 7, total: 42 });
    expect(seen).toEqual([["channels", "9:C2", 10], ["page", "C1", 12, 50]]);
  });
});

describe("searching the Slack directory", () => {
  const member = (id: string, realName: string) => ({
    id, handle: realName.toLowerCase(), realName, displayName: "", title: "Engineer", email: "", avatar: "a.png",
    deleted: false, isBot: false,
  });

  test("refuses without a directory, so the page falls back to a pasted id", async () => {
    const { app } = ports();
    expect(await app.searchMembers("an")).toMatchObject({ ok: false, status: 503 });
  });

  test("marks people already on the list with their role", async () => {
    const { app, users } = ports({
      directory: { search: async () => [member("U1", "Ann"), member("U2", "Bea")] },
    });
    users.set("U2", { slackId: "U2", role: "admin", displayName: "Bea", addedBy: "x", createdAt: 1 });
    const out = await app.searchMembers(" a ");
    expect(out.ok && out.value.members).toEqual([
      { id: "U1", handle: "ann", realName: "Ann", displayName: "", title: "Engineer", avatar: "a.png", role: undefined },
      { id: "U2", handle: "bea", realName: "Bea", displayName: "", title: "Engineer", avatar: "a.png", role: "admin" },
    ]);
  });

  test("a directory that cannot be read is a 502, not an empty list", async () => {
    const { app } = ports({ directory: { search: async () => Promise.reject(new Error("missing_scope")) } });
    expect(await app.searchMembers("a")).toMatchObject({ ok: false, status: 502, error: expect.stringContaining("missing_scope") });
  });

  test("adding a picked person stores their name, but never overwrites one", () => {
    const { app, users } = ports();
    expect(app.saveUser("U5", "pal", "Cleo").ok).toBe(true);
    expect(users.get("U5")?.displayName).toBe("Cleo");
    app.saveUser("U5", "admin", "Someone Else");
    expect(users.get("U5")).toMatchObject({ displayName: "Cleo", role: "admin" });
  });
});

describe("overview stats", () => {
  test("not recording without a stats store", async () => {
    expect(await ports().app.stats(null)).toEqual({ recording: false });
  });

  test("fills every day, names the busiest people, counts live threads", async () => {
    const DAY = 86_400_000;
    const now = 20 * DAY + 3_600_000;
    const sinces: number[] = [];
    const { app } = ports({
      clock: () => now,
      timezoneOffset: () => 0,
      names: createNameResolver({ clock: () => now, knownName: (id) => (id === "U1" ? "Ann" : undefined) }),
      stats: {
        messagesPerDay: (since) => {
          sinces.push(since);
          return [{ day: 20, user: 2, assistant: 3 }];
        },
        turnsPerDay: () => [{ day: 19, ok: 4, failed: 1 }],
        spendPerDay: () => [],
        topCommands: () => [{ key: "review", runs: 3, failed: 1 }],
        topUsers: () => [{ key: "U1", turns: 5, commands: 2 }],
        activeThreads: (since) => (since === 20 * DAY ? 1 : since === 14 * DAY ? 4 : 6),
      },
    });
    const out = await app.stats("3");
    if (!out.recording) throw new Error("expected stats");
    expect(sinces).toEqual([18 * DAY]);
    expect(out.messages).toEqual([
      { date: "1970-01-19", user: 0, assistant: 0 },
      { date: "1970-01-20", user: 0, assistant: 0 },
      { date: "1970-01-21", user: 2, assistant: 3 },
    ]);
    expect(out.turns.map((d) => d.ok)).toEqual([0, 4, 0]);
    expect(out.spend.every((d) => d.runs === 0 && d.costUsd === 0)).toBe(true);
    expect(out.topUsers).toEqual([{ key: "U1", turns: 5, commands: 2, label: "Ann (U1)" }]);
    expect(out.activeThreads).toEqual({ day: 1, week: 4, window: 6 });
  });
});
