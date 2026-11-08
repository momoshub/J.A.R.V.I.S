import { describe, expect, test } from "bun:test";
import { createDashboardService, usageWindowMs, type DashboardPorts, type MemoryAdapterPort } from "../../src/application/dashboard.ts";
import type { AllowedUser } from "../../src/domain/types.ts";
import { SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";

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
      remove: (id) => void users.delete(id),
    },
    messages: {
      channels: () => [{ channelId: "C1" }],
      count: () => 3,
      recentForChannel: (c, limit) => [{ c, limit }],
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
    app.saveUser("U2", "owner");
    expect(users.get("U2")?.role).toBe("pal");
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

  test("conversations clamp to a limit and ignore a blank channel on clear", () => {
    const { app, cleared } = ports();
    expect(app.conversation("")).toEqual([]);
    expect(app.conversation("C1")).toEqual([{ c: "C1", limit: 200 }]);
    app.clearConversation("  ");
    app.clearConversation(" C1 ");
    expect(cleared).toEqual(["C1"]);
  });

  test("usage reports not recording without a store, and clamps its window", () => {
    expect(ports().app.usage("24")).toEqual({ recording: false });
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
});
