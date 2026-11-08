import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createKitViewRepo } from "../../src/infrastructure/db/kitViewRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "../../src/application/botProfile.ts";
import { createDashboard, type DashboardDeps } from "../../src/infrastructure/dashboard/server.ts";

const OWNER = "U0OWNER0001";

const build = (extra: Partial<DashboardDeps> = {}) => {
  const db = openDatabase(":memory:");
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  const learnings = createLearningsRepo(db);
  const settings = createSettingsRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  const profile = () =>
    loadBotProfile(settings, { name: "TestBot", thinkingLabel: "thinking...", thinkingDoneLabel: "✅" });
  const dash = createDashboard(
    { port: 0, ownerSlackId: OWNER, model: "claude-opus-4-8", distDir: "/nonexistent", commandPrefix: "//bot", slashCommand: "/bot" },
    { users, messages, learnings, settings, clock: () => 99, profile, ...extra },
  );
  return { dash, users, messages, learnings, settings };
};

const api = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

describe("dashboard static + api", () => {
  test("api needs no token (local, loopback-only)", async () => {
    const res = await build().dash.handle(api("/api/overview"));
    expect(res.status).toBe(200);
  });

  test("health responds", async () => {
    const res = await build().dash.handle(api("/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("the restart endpoint defers to the handler and says so", async () => {
    const asked: string[] = [];
    const d = build({ requestRestart: (r) => asked.push(r) });
    const res = await d.dash.handle(postJson("/api/restart", { reason: "picked up a fix" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { restarting: boolean }).toMatchObject({ ok: true, restarting: true });
    expect(asked).toEqual(["picked up a fix"]);
  });

  test("without self-restart wired, it refuses rather than pretending", async () => {
    const res = await build().dash.handle(postJson("/api/restart", {}));
    expect(res.status).toBe(503);
  });

  test("health reports whether the bot can hear Slack, not whether it is running", async () => {
    // the failure this exists for: twice the process was up and this endpoint
    // answered while the bot had not heard a word for hours
    const deaf = build({ slackHealth: () => ({ state: "reconnecting", since: 0 }) });
    const res = await deaf.dash.handle(api("/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; slack: string };
    expect(body.ok).toBe(false);
    expect(body.slack).toContain("NOT listening");

    const live = build({ slackHealth: () => ({ state: "connected", since: 0 }) });
    const good = await live.dash.handle(api("/health"));
    expect(good.status).toBe(200);
    expect(((await good.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("a draining bot is NOT listening, however healthy its socket", async () => {
    // the socket can be perfect while the inbox is not read at all. Reporting
    // "listening" through that is the same lie the watchdog exists to stop,
    // arriving from the other side - and it is how a planned restart got
    // reported as a bug after four unanswered messages
    const drain = build({
      slackHealth: () => ({ state: "connected", since: 0 }),
      draining: () => true,
    });
    const res = await drain.dash.handle(api("/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; slack: string; draining?: boolean };
    expect(body.ok).toBe(false);
    expect(body.draining).toBe(true);
    expect(body.slack).toContain("not taking new work");
  });

  test("once it is done draining it is listening again", async () => {
    const back = build({ slackHealth: () => ({ state: "connected", since: 0 }), draining: () => false });
    const res = await back.dash.handle(api("/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("health reports desktop access without letting it fail the bot", async () => {
    // it is not fatal - almost nothing needs the UI - which is exactly why its
    // absence goes unnoticed for weeks unless something says so
    const denied = build({
      slackHealth: () => ({ state: "connected", since: 0 }),
      uiAccess: async () => ({ access: "denied" as const, checkedAt: 7 }),
    });
    const res = await denied.dash.handle(api("/health"));
    expect(res.status).toBe(200); // still 200: the socket is what `ok` means
    const body = (await res.json()) as { ok: boolean; ui: string; uiState: string };
    expect(body.ok).toBe(true);
    expect(body.ui).toContain("REFUSED");
    expect(body.uiState).toBe("denied");

    const fine = build({
      slackHealth: () => ({ state: "connected", since: 0 }),
      uiAccess: async () => ({ access: "granted" as const, checkedAt: 7 }),
    });
    expect(((await (await fine.dash.handle(api("/health"))).json()) as { ui: string }).ui).toContain("allowed");
  });

  test("a probe that throws does not take the health endpoint with it", async () => {
    const broken = build({
      slackHealth: () => ({ state: "connected", since: 0 }),
      uiAccess: async () => {
        throw new Error("osascript exploded");
      },
    });
    const res = await broken.dash.handle(api("/health"));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ui?: string }).not.toHaveProperty("ui");
  });

  test("static falls back to a 500 hint when the build is missing", async () => {
    // distDir does not exist, so serveStatic reports the build is missing.
    const res = await build().dash.handle(api("/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("build");
  });

  test("sets security headers", async () => {
    const res = await build().dash.handle(api(`/api/overview`));
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("dashboard read API", () => {
  test("overview returns counts", async () => {
    const { dash, messages, learnings } = build();
    messages.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "x" }, 1);
    learnings.add("l", "kai", 1);
    const res = await dash.handle(api(`/api/overview`));
    expect(await res.json()).toMatchObject({ users: 1, conversations: 1, messages: 1, learnings: 1 });
  });

  test("bootstrap exposes bot name and owner", async () => {
    const { dash } = build();
    expect(await (await dash.handle(api(`/api/bootstrap`))).json()).toMatchObject({
      botName: "TestBot",
      ownerSlackId: OWNER,
    });
  });

  test("identity returns persona + labels", async () => {
    const { dash } = build();
    const id = (await (await dash.handle(api(`/api/identity`))).json()) as {
      usingDefault: boolean;
      persona: string;
    };
    expect(id.usingDefault).toBe(true);
    expect(id.persona).toContain("friendly, calm and helpful");
  });
});

describe("dashboard mutations", () => {
  test("adds a user via JSON POST", async () => {
    const { dash, users } = build();
    const res = await dash.handle(postJson(`/api/users`, { slackId: "U999", role: "admin" }));
    expect(res.status).toBe(200);
    expect(users.get("U999")?.role).toBe("admin");
  });

  test("rejects a malformed slack id", async () => {
    const res = await build().dash.handle(postJson(`/api/users`, { slackId: "nope" }));
    expect(res.status).toBe(400);
  });

  test("refuses to modify the owner", async () => {
    const { dash, users } = build();
    const res = await dash.handle(postJson(`/api/users`, { slackId: OWNER, role: "admin" }));
    expect(res.status).toBe(400);
    expect(users.get(OWNER)?.role).toBe("owner");
  });

  test("refuses to remove the owner", async () => {
    const { dash, users } = build();
    const res = await dash.handle(postJson(`/api/users/remove`, { slackId: OWNER }));
    expect(res.status).toBe(400);
    expect(users.get(OWNER)).toBeDefined();
  });

  test("rejects a cross-origin POST", async () => {
    const { dash, users } = build();
    const res = await dash.handle(
      postJson(`/api/users`, { slackId: "U777" }, { origin: "http://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(users.get("U777")).toBeUndefined();
  });

  test("allows a loopback origin that differs from the request host", async () => {
    const { dash, users } = build();
    const res = await dash.handle(
      new Request(`http://127.0.0.1/api/users`, {
        method: "POST",
        body: JSON.stringify({ slackId: "U444", role: "pal" }),
        headers: { "content-type": "application/json", origin: "http://localhost:2001" },
      }),
    );
    expect(res.status).toBe(200);
    expect(users.get("U444")?.role).toBe("pal");
  });

  test("learnings add/remove", async () => {
    const { dash, learnings } = build();
    await dash.handle(postJson(`/api/learnings`, { content: "staging is X" }));
    const [l] = learnings.list();
    expect(l?.content).toBe("staging is X");
    await dash.handle(postJson(`/api/learnings/remove`, { id: l!.id }));
    expect(learnings.list()).toHaveLength(0);
  });

  test("identity save sets name, labels and persona", async () => {
    const { dash, settings } = build();
    await dash.handle(
      postJson(`/api/identity`, {
        name: "Evie",
        thinkingLabel: "☄️",
        thinkingDoneLabel: "🐦‍🔥",
        prompt: "You are terse.",
      }),
    );
    expect(settings.get(SETTING_KEYS.botName)).toBe("Evie");
    expect(settings.get(SETTING_KEYS.thinkingDoneLabel)).toBe("🐦‍🔥");
    expect(settings.get(SETTING_KEYS.systemPrompt)).toBe("You are terse.");
  });

  test("identity requires a name", async () => {
    const res = await build().dash.handle(postJson(`/api/identity`, { name: "  " }));
    expect(res.status).toBe(400);
  });

  test("prompt reset clears the override", async () => {
    const { dash, settings } = build();
    settings.set(SETTING_KEYS.systemPrompt, "custom");
    await dash.handle(postJson(`/api/prompt/reset`, {}));
    expect(settings.get(SETTING_KEYS.systemPrompt)).toBeUndefined();
  });

  test("conversation clear wipes a channel", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "x" }, 1);
    await dash.handle(postJson(`/api/conversation/clear`, { channel: "C9" }));
    expect(messages.recentForChannel("C9", 10)).toHaveLength(0);
  });
});

describe("editing a learning", () => {
  test("rewords it in place", async () => {
    const { dash, learnings } = build();
    learnings.add("staging is at old.example.com", "dashboard", 1);
    const id = learnings.list()[0]!.id;

    const res = await dash.handle(postJson("/api/learnings/update", { id, content: "staging is at new.example.com" }));
    expect(res.status).toBe(200);
    expect(learnings.list()[0]?.content).toBe("staging is at new.example.com");
    expect(learnings.list()).toHaveLength(1);
  });

  test("refuses to blank one out or to guess at the id", async () => {
    const { dash, learnings } = build();
    learnings.add("a fact", "dashboard", 1);
    const id = learnings.list()[0]!.id;

    expect((await dash.handle(postJson("/api/learnings/update", { id, content: "   " }))).status).toBe(400);
    expect((await dash.handle(postJson("/api/learnings/update", { content: "hi" }))).status).toBe(400);
    expect(learnings.list()[0]?.content).toBe("a fact");
  });
});

describe("running a command through the API", () => {
  const withRunner = () => {
    const db = openDatabase(":memory:");
    const users = createUserRepo(db);
    const messages = createMessageRepo(db);
    const learnings = createLearningsRepo(db);
    const settings = createSettingsRepo(db);
    users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
    const seen: unknown[] = [];
    const profile = () =>
      loadBotProfile(settings, { name: "TestBot", thinkingLabel: "thinking...", thinkingDoneLabel: "✅" });
    const dash = createDashboard(
      { port: 0, ownerSlackId: OWNER, model: "m", distDir: "/nonexistent", commandPrefix: "//bot", slashCommand: "/bot" },
      {
        users,
        messages,
        learnings,
        settings,
        clock: () => 99,
        profile,
        runCommand: async (req) => {
          seen.push(req);
          if (req.ticket === "stale") throw new Error("that ticket is not valid any more");
          return { result: `ran ${req.line}`, posted: true };
        },
      },
    );
    return { dash, seen };
  };

  test("passes the ticket and line through, and nothing else", async () => {
    const { dash, seen } = withRunner();
    const res = await dash.handle(
      postJson("/api/commands/run", {
        ticket: "tkt123",
        line: "review https://github.com/o/r/pull/1",
        // a caller trying to name someone must not get anywhere
        actor: "Usomeoneelse",
        channel: "Celsewhere",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: "ran review https://github.com/o/r/pull/1", posted: true });
    expect(seen[0]).toEqual({ ticket: "tkt123", line: "review https://github.com/o/r/pull/1" });
  });

  test("ticket and line are both required", async () => {
    const { dash, seen } = withRunner();
    expect((await dash.handle(postJson("/api/commands/run", { line: "ping" }))).status).toBe(400);
    expect((await dash.handle(postJson("/api/commands/run", { ticket: "t" }))).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("a spent or unknown ticket is refused, not guessed at", async () => {
    const { dash } = withRunner();
    const res = await dash.handle(postJson("/api/commands/run", { ticket: "stale", line: "ping" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "that ticket is not valid any more" });
  });

  test("without a runner wired in, the endpoint is simply not there", async () => {
    const { dash } = build();
    const res = await dash.handle(postJson("/api/commands/run", { ticket: "t", line: "ping" }));
    expect(res.status).toBe(503);
  });

  test("a cross-origin post is still refused", async () => {
    const { dash, seen } = withRunner();
    const res = await dash.handle(
      postJson("/api/commands/run", { ticket: "t", line: "ping" }, { origin: "http://evil.example" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(0);
  });
});

describe("storing a modal for a button to open", () => {
  const withViews = () => {
    const db = openDatabase(":memory:");
    const kitViews = createKitViewRepo(db);
    return { ...build({ kitViews }), kitViews };
  };

  test("a valid modal is stored and its button id handed back", async () => {
    const { dash, kitViews } = withViews();
    const view = { type: "modal", title: { type: "plain_text", text: "Ticket" }, blocks: [] };
    const res = await dash.handle(postJson("/api/kit/views", { view }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; action_id: string };
    expect(body.action_id).toBe(`jv:modal:${body.id}`);
    expect(kitViews.get(body.id)).toEqual(view);
  });

  test("a view that could not open is refused now, not on click", async () => {
    const res = await withViews().dash.handle(postJson("/api/kit/views", { view: { type: "modal", blocks: [] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("title");
  });

  test("without storage wired it says so", async () => {
    const res = await build().dash.handle(postJson("/api/kit/views", { view: {} }));
    expect(res.status).toBe(503);
  });
});

describe("editing memory files by hand", () => {
  const fakeAdapter = () => {
    const files = new Map([["memory/NOTES.md", "- old\n"]]);
    const edits: { path: string; content: string; by: string }[] = [];
    const adapter: NonNullable<DashboardDeps["adapter"]> = {
      status: () => "",
      view: () => ({ policy: "", notes: "", skills: [], people: [], channels: [], revisions: [], items: 0 }),
      remember: () => ({ ok: true }),
      revert: () => ({ ok: true }),
      files: () => [...files].map(([path, content]) => ({ path, content })),
      edit: (path, content, by) => {
        if (path.includes("..")) return { ok: false, violations: ["Not a path inside the adapter"] };
        edits.push({ path, content, by });
        files.set(path, content);
        return { ok: true, warnings: ["over budget"] };
      },
    };
    return { adapter, edits };
  };

  test("lists every file and saves one through the adapter, as the dashboard", async () => {
    const { adapter, edits } = fakeAdapter();
    const { dash } = build({ adapter });
    const listed = await (await dash.handle(api("/api/adapter/files"))).json();
    expect(listed).toEqual([{ path: "memory/NOTES.md", content: "- old\n" }]);

    const res = await dash.handle(postJson("/api/adapter/file", { path: "memory/NOTES.md", content: "- new" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warnings: ["over budget"] });
    expect(edits).toEqual([{ path: "memory/NOTES.md", content: "- new", by: "dashboard" }]);
  });

  test("a refusal from the gate comes back as an error, and a missing path or content is refused", async () => {
    const { adapter, edits } = fakeAdapter();
    const { dash } = build({ adapter });
    expect((await dash.handle(postJson("/api/adapter/file", { path: "../x", content: "y" }))).status).toBe(400);
    expect((await dash.handle(postJson("/api/adapter/file", { content: "y" }))).status).toBe(400);
    expect((await dash.handle(postJson("/api/adapter/file", { path: "memory/NOTES.md" }))).status).toBe(400);
    expect(edits).toHaveLength(0);
  });

  test("it is a cross-origin-guarded mutation like the rest", async () => {
    const { adapter, edits } = fakeAdapter();
    const { dash } = build({ adapter });
    const res = await dash.handle(
      postJson("/api/adapter/file", { path: "memory/NOTES.md", content: "x" }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(edits).toHaveLength(0);
  });

  test("with no adapter there is nothing to edit", async () => {
    const { dash } = build();
    expect((await dash.handle(api("/api/adapter/files"))).status).toBe(404);
    expect((await dash.handle(postJson("/api/adapter/file", { path: "a.md", content: "x" }))).status).toBe(400);
  });
});
