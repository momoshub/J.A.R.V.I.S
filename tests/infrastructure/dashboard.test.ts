import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createThreadBriefRepo } from "../../src/infrastructure/db/threadBriefRepo.ts";
import { tellPrompt } from "../../src/domain/tellPrompt.ts";
import { migrate } from "../../src/infrastructure/db/schema.ts";
import { createThreadSessionRepo } from "../../src/infrastructure/db/threadSessionRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createKitViewRepo } from "../../src/infrastructure/db/kitViewRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "../../src/application/botProfile.ts";
import { createDashboard, type DashboardDeps } from "../../src/infrastructure/dashboard/server.ts";
import { createRoleRepo } from "../../src/infrastructure/db/roleRepo.ts";
import { seedRoles } from "../../src/application/roles.ts";
import { listCommandInfo } from "../../src/application/commands.ts";
import { createSlackProxy } from "../../src/application/slackProxy.ts";
import type { SlackAdminPort } from "../../src/application/slackAdmin.ts";
import { createSlackTickets } from "../../src/application/slackTickets.ts";

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
    {
      users,
      messages,
      learnings,
      learningApproval: { learnings, clock: () => 99, ownerSlackId: OWNER },
      settings,
      clock: () => 99,
      profile,
      ...extra,
    },
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

  test("the Console's workspace endpoint answers the Slack workspace url, null without one, 503 without Slack", async () => {
    const slack = (url?: string) => ({ workspaceUrl: async () => url }) as unknown as DashboardDeps["slack"];
    const ok = await build({ slack: slack("https://acme.slack.com") }).dash.handle(api("/api/slack/workspace"));
    expect(await ok.json()).toEqual({ url: "https://acme.slack.com" });
    const none = await build({ slack: slack() }).dash.handle(api("/api/slack/workspace"));
    expect(await none.json()).toEqual({ url: null });
    expect((await build().dash.handle(api("/api/slack/workspace"))).status).toBe(503);
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

  describe("the Slack proxy endpoints", () => {
    const wired = () => {
      const tickets = createSlackTickets(() => 0);
      const upstream: { url: string; auth: string }[] = [];
      const proxy = createSlackProxy({
        tickets,
        botToken: "xoxb-held-by-the-bot",
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          upstream.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization) });
          return String(url).includes("files")
            ? new Response("BYTES", { headers: { "content-type": "image/png" } })
            : Response.json({ ok: true, user: { id: "U1" } });
        }) as typeof fetch,
      });
      return { d: build({ slackProxy: proxy }), tickets, upstream };
    };

    test("an allowed call is proxied and answers in Slack's own shape", async () => {
      const { d, tickets, upstream } = wired();
      const ticket = tickets.issue({ channel: "C1" });
      const res = await d.dash.handle(postJson("/api/slack/proxy", { ticket, method: "users.info", params: { user: "U1" } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, user: { id: "U1" } });
      expect(upstream).toEqual([{ url: "https://slack.com/api/users.info", auth: "Bearer xoxb-held-by-the-bot" }]);
    });

    test("no ticket, a bad ticket and a method off the allowlist never reach Slack", async () => {
      const { d, tickets, upstream } = wired();
      expect((await d.dash.handle(postJson("/api/slack/proxy", { method: "users.info", params: { user: "U1" } }))).status).toBe(401);
      expect((await d.dash.handle(postJson("/api/slack/proxy", { ticket: "jvsl_nope", method: "users.info", params: {} }))).status).toBe(401);
      const ticket = tickets.issue({ channel: "C1" });
      const denied = await d.dash.handle(postJson("/api/slack/proxy", { ticket, method: "conversations.archive", params: { channel: "C1" } }));
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: string }).error).toContain("method_not_allowed");
      expect(upstream).toEqual([]);
    });

    test("a file download is streamed back, and a non-Slack url is refused", async () => {
      const { d, tickets } = wired();
      const ticket = tickets.issue({ channel: "C1" });
      const file = await d.dash.handle(postJson("/api/slack/file", { ticket, url: "https://files.slack.com/files-pri/T1-F1/a.png" }));
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/png");
      expect(await file.text()).toBe("BYTES");
      expect((await d.dash.handle(postJson("/api/slack/file", { ticket, url: "https://evil.example/a.png" }))).status).toBe(403);
    });

    test("without a proxy wired the endpoints say so", async () => {
      expect((await build().dash.handle(postJson("/api/slack/proxy", { ticket: "t", method: "users.info" }))).status).toBe(503);
      expect((await build().dash.handle(postJson("/api/slack/file", { ticket: "t", url: "x" }))).status).toBe(503);
    });
  });

  test("the github-app action endpoint needs a ticket, passes the rest on and reports refusals", async () => {
    const seen: Record<string, unknown>[] = [];
    const d = build({
      githubAction: async (req) => {
        seen.push(req);
        if (req.ticket === "pal") throw new Error("needs the executer role");
        return { url: "https://github.com/o/r/pull/1", number: 1 };
      },
    });
    expect((await d.dash.handle(postJson("/api/github-app/action", { action: "pr-close", repo: "o/r", number: 1 }))).status).toBe(400);
    expect(seen).toEqual([]);
    const ok = await d.dash.handle(postJson("/api/github-app/action", { ticket: "t1", action: "pr-close", repo: "o/r", number: 1 }));
    expect(await ok.json()).toMatchObject({ ok: true, number: 1 });
    expect(seen[0]).toMatchObject({ ticket: "t1", action: "pr-close" });
    const denied = await d.dash.handle(postJson("/api/github-app/action", { ticket: "pal", action: "pr-close" }));
    expect(denied.status).toBe(500);
    expect(((await denied.json()) as { error: string }).error).toContain("executer role");
    expect((await build().dash.handle(postJson("/api/github-app/action", { ticket: "t" }))).status).toBe(503);
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
    learnings.add("l", "kai", 1, "active");
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

  test("learnings: a POST is pending and says so, remove deletes", async () => {
    const { dash, learnings } = build();
    const res = await dash.handle(postJson(`/api/learnings`, { content: "staging is at stg.example.com" }));
    const body = (await res.json()) as { ok: boolean; status: string; id: number; message: string };
    expect(body).toMatchObject({ ok: true, status: "pending" });
    expect(body.message).toContain("Pending owner approval");
    expect(body.message).toContain("NOT saved");
    // never active: nothing the prompt reads
    expect(learnings.list()).toHaveLength(0);
    const [l] = learnings.pending();
    expect(l?.content).toBe("staging is at stg.example.com");
    await dash.handle(postJson(`/api/learnings/remove`, { id: l!.id }));
    expect(learnings.pending()).toHaveLength(0);
  });

  test("learnings are refused when approval is not wired, never saved unchecked", async () => {
    const { dash, learnings } = build({ learningApproval: undefined });
    const res = await dash.handle(postJson(`/api/learnings`, { content: "staging is at stg.example.com" }));
    expect(res.status).toBe(503);
    expect(learnings.pending()).toHaveLength(0);
    expect(learnings.list()).toHaveLength(0);
  });

  test("identity save sets name, labels and persona", async () => {
    const { dash, settings } = build();
    await dash.handle(
      postJson(`/api/identity`, {
        name: "Jarvis",
        thinkingLabel: "☄️",
        thinkingDoneLabel: "🐦‍🔥",
        prompt: "You are terse.",
      }),
    );
    expect(settings.get(SETTING_KEYS.botName)).toBe("Jarvis");
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

  test("conversation clear with a threadTs wipes only that thread", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "top" }, 1);
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "t1", threadTs: "5.1" }, 2);
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "t2", threadTs: "6.1" }, 3);
    await dash.handle(postJson(`/api/conversation/clear`, { channel: "C9", threadTs: "5.1" }));
    expect(messages.recentForChannel("C9", 10).map((m) => m.content)).toEqual(["top", "t2"]);
  });

  test("a thread clear with a blank threadTs is refused and wipes nothing", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "t1", threadTs: "5.1" }, 1);
    const res = await dash.handle(postJson(`/api/conversation/clear`, { channel: "C9", threadTs: " " }));
    expect(res.status).toBe(400);
    expect(messages.recentForChannel("C9", 10)).toHaveLength(1);
  });

  test("clearing from the console drops the thread sessions it would replay", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const threadSessions = createThreadSessionRepo(db);
    threadSessions.claim("C9", "5.1", "full", "s1", "5.1", 1, "h");
    threadSessions.claim("C9", "6.1", "full", "s2", "6.1", 1, "h");
    threadSessions.claim("C8", "6.1", "full", "s3", "6.1", 1, "h");
    const { dash } = build({ threadSessions });
    await dash.handle(postJson(`/api/conversation/clear`, { channel: "C9", threadTs: "5.1" }));
    expect(threadSessions.find("C9", "5.1", "full")).toBeUndefined();
    expect(threadSessions.find("C9", "6.1", "full")?.sessionId).toBe("s2");
    await dash.handle(postJson(`/api/conversation/clear`, { channel: "C9" }));
    expect(threadSessions.find("C9", "6.1", "full")).toBeUndefined();
    expect(threadSessions.find("C8", "6.1", "full")?.sessionId).toBe("s3");
  });

  test("conversation clear wipes a channel", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "x" }, 1);
    await dash.handle(postJson(`/api/conversation/clear`, { channel: "C9" }));
    expect(messages.recentForChannel("C9", 10)).toHaveLength(0);
  });
});

describe("editing a learning", () => {
  test("rewording through the API takes it out of the prompt until the owner approves the new text", async () => {
    const { dash, learnings } = build();
    learnings.add("staging is at old.example.com", "dashboard", 1, "active");
    const id = learnings.list()[0]!.id;

    const res = await dash.handle(postJson("/api/learnings/update", { id, content: "staging is at new.example.com" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("pending");
    expect(learnings.list()).toHaveLength(0);
    expect(learnings.get(id)).toMatchObject({ status: "pending", content: "staging is at new.example.com" });
  });

  test("the API reports the real status: the same text leaves it active and says so", async () => {
    const { dash, learnings } = build();
    learnings.add("staging is at stg.example.com", "dashboard", 1, "active");
    const id = learnings.list()[0]!.id;
    const res = await dash.handle(postJson("/api/learnings/update", { id, content: "staging is at stg.example.com" }));
    const body = (await res.json()) as { status: string; message: string };
    expect(body.status).toBe("active");
    expect(body.message).toContain("Unchanged");
    expect(learnings.list()).toHaveLength(1);
  });

  test("refuses to blank one out or to guess at the id", async () => {
    const { dash, learnings } = build();
    learnings.add("a fact", "dashboard", 1, "active");
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

  test("show is passed through only when true, and must be a boolean", async () => {
    const { dash, seen } = withRunner();
    await dash.handle(postJson("/api/commands/run", { ticket: "t", line: "ping", show: true }));
    await dash.handle(postJson("/api/commands/run", { ticket: "t", line: "ping", show: false }));
    expect(seen[0]).toEqual({ ticket: "t", line: "ping", show: true });
    expect(seen[1]).toEqual({ ticket: "t", line: "ping" });
    expect((await dash.handle(postJson("/api/commands/run", { ticket: "t", line: "ping", show: "yes" }))).status).toBe(400);
    expect(seen).toHaveLength(2);
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
    const edits: { path: string; content: string; by: string; base?: string }[] = [];
    const adapter: NonNullable<DashboardDeps["adapter"]> = {
      status: () => "",
      view: () => ({ policy: "", notes: "", skills: [], people: [], channels: [], revisions: [], items: 0 }),
      revert: () => ({ ok: true }),
      files: () => [...files].map(([path, content]) => ({ path, content })),
      edit: (path, content, by, base) => {
        if (path.includes("..")) return { ok: false, violations: ["Not a path inside the adapter"] };
        edits.push({ path, content, by, ...(base === undefined ? {} : { base }) });
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

    await dash.handle(postJson("/api/adapter/file", { path: "memory/NOTES.md", content: "- newer", base: "- new" }));
    expect(edits[1]).toEqual({ path: "memory/NOTES.md", content: "- newer", by: "dashboard", base: "- new" });
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

describe("paging, stats and the Slack directory over HTTP", () => {
  test("memory endpoints say which channels and threads the DB holds, and flip after a clear", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "a" }, 1);
    messages.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "b", threadTs: "7.1" }, 2);
    messages.append({ channelId: "C2", slackUserId: "U1", role: "user", content: "c" }, 3);
    const chans = (await (await dash.handle(api(`/api/memory/channels`))).json()) as { channelId: string; count: number }[];
    expect(chans.map((c) => [c.channelId, c.count])).toEqual([["C2", 1], ["C1", 2]]);
    const threads = (await (await dash.handle(api(`/api/memory/threads?channel=C1`))).json()) as { threadTs: string; count: number }[];
    expect(threads).toMatchObject([{ threadTs: "7.1", count: 1 }]);
    expect(await (await dash.handle(api(`/api/memory/threads`))).json()).toEqual([]);
    await dash.handle(postJson(`/api/conversation/clear`, { channel: "C1" }));
    const after = (await (await dash.handle(api(`/api/memory/channels`))).json()) as { channelId: string }[];
    expect(after.map((c) => c.channelId)).toEqual(["C2"]);
  });

  test("memory/internal interleaves stored steer turns and briefs, read-only, scoped to a channel or thread", async () => {
    const briefs = createThreadBriefRepo(openDatabase(":memory:"));
    const { dash, messages } = build({ briefs });
    messages.append({ channelId: "C1", slackUserId: "U9", role: "user", content: tellPrompt("U9", "ship it"), threadTs: "7.1" }, 30);
    messages.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "a real person typed this", threadTs: "7.1" }, 31);
    messages.append({ channelId: "C1", slackUserId: "assistant", role: "assistant", content: "NO_REPLY", threadTs: "7.1" }, 32);
    messages.append({ channelId: "C2", slackUserId: "U9", role: "user", content: tellPrompt("U9", "elsewhere"), threadTs: "7.1" }, 33);
    briefs.add({ fromChannel: "D0", fromThread: "1.1", toChannel: "C1", toThread: "7.1", author: "U8", text: "note xoxb-1234567890-abcdefghij" }, 20);
    briefs.add({ fromChannel: "D0", fromThread: "1.1", toChannel: "C1", toThread: "8.8", author: "U8", text: "other thread" }, 40);
    const get = async (path: string) => dash.handle(api(path));
    const all = (await (await get("/api/memory/internal?channel=C1")).json()) as { ok?: boolean; items: { id: string; kind: string; source: string; text: string; at: number; threadTs: string }[] };
    expect(all.items.map((i) => [i.kind, i.source, i.text, i.at, i.threadTs])).toEqual([
      ["brief", "U8", "note [redacted]", 20, "7.1"],
      ["tell", "U9", "ship it", 30, "7.1"],
      ["brief", "U8", "other thread", 40, "8.8"],
    ]);
    const one = (await (await get("/api/memory/internal?channel=C1&thread=8.8")).json()) as { items: { text: string }[] };
    expect(one.items.map((i) => i.text)).toEqual(["other thread"]);
    expect(((await (await get("/api/memory/internal?channel=C404")).json()) as { items: unknown[] }).items).toEqual([]);
    expect((await get("/api/memory/internal")).status).toBe(400);
    expect((await get("/api/memory/internal?channel=C1&thread=")).status).toBe(400);
    // Read-only: no write verb reaches it.
    expect((await dash.handle(postJson("/api/memory/internal", { channel: "C1" }))).status).toBe(404);
    expect(messages.count()).toBe(4);
  });

  test("memory/internal works without a brief store (older wiring): steer turns only", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C1", slackUserId: "U9", role: "user", content: tellPrompt("U9", "hi") }, 5);
    const res = (await (await dash.handle(api("/api/memory/internal?channel=C1"))).json()) as { items: { kind: string }[] };
    expect(res.items.map((i) => i.kind)).toEqual(["tell"]);
  });

  test("memory/internal and memory/turns take a time window and a page size", async () => {
    const { dash, messages } = build();
    for (const at of [10, 20, 30]) messages.append({ channelId: "C1", slackUserId: "U9", role: "user", content: tellPrompt("U9", `n${at}`), threadTs: "7.1" }, at);
    const internal = async (qs: string) => ((await (await dash.handle(api(`/api/memory/internal?channel=C1${qs}`))).json()) as { items: { at: number }[] }).items.map((i) => i.at);
    expect(await internal("&since=20")).toEqual([20, 30]);
    expect(await internal("&since=10&before=30")).toEqual([10, 20]);
    expect(await internal("&limit=1")).toEqual([30]);
    expect(await internal("&since=nonsense")).toEqual([10, 20, 30]);
  });

  test("memory/turns is the DB copy: ordinary turns only, redacted, scoped to channel or thread and a window, read-only", async () => {
    const { dash, messages } = build();
    const add = (role: "user" | "assistant", content: string, at: number, extra: { slackTs?: string; threadTs?: string; channelId?: string } = {}) =>
      messages.append({ channelId: extra.channelId ?? "C1", slackUserId: role === "user" ? "U1" : "assistant", role, content, ...(extra.slackTs ? { slackTs: extra.slackTs } : {}), threadTs: extra.threadTs ?? "" }, at);
    add("user", "asked a thing xoxb-1234567890-abcdefghij", 10, { slackTs: "1.5" });
    add("assistant", "the answer", 11);
    add("assistant", "NO_REPLY", 12);
    add("user", tellPrompt("U9", "steer"), 13, { slackTs: "13.0" });
    add("user", "in a thread", 14, { slackTs: "9.9", threadTs: "9.9" });
    add("assistant", "thread answer", 15, { threadTs: "9.9" });
    add("user", "elsewhere", 16, { channelId: "C2" });
    const get = async (qs: string) => ((await (await dash.handle(api(`/api/memory/turns?${qs}`))).json()) as { items: { role: string; userId: string; text: string; ts: string; threadTs: string }[] }).items;
    expect((await get("channel=C1")).map((t) => [t.role, t.text, t.ts])).toEqual([
      ["user", "asked a thing [redacted]", "1.5"],
      ["assistant", "the answer", ""],
      ["user", "in a thread", "9.9"],
    ]);
    expect((await get("channel=C1&thread=9.9")).map((t) => t.text)).toEqual(["in a thread", "thread answer"]);
    expect((await get("channel=C1&since=11&before=14")).map((t) => t.text)).toEqual(["the answer"]);
    expect((await get("channel=C1")).map((t) => t.userId)).toEqual(["U1", "assistant", "U1"]);
    expect((await dash.handle(api("/api/memory/turns"))).status).toBe(400);
    expect((await dash.handle(api("/api/memory/turns?channel=C1&thread="))).status).toBe(400);
    expect((await dash.handle(postJson("/api/memory/turns", { channel: "C1" }))).status).toBe(404);
    expect(messages.count()).toBe(7);
  });

  test("slack/thread pages the replies: newest page first, `before` goes older, hasMore says so", async () => {
    const replies = ["1.0", "2.0", "3.0", "4.0"].map((ts) => ({ ts }));
    const slack = { replies: async () => replies } as unknown as NonNullable<DashboardDeps["slack"]>;
    const { dash } = build({ slack });
    const get = async (qs: string) => (await (await dash.handle(api(`/api/slack/thread?channel=C1&ts=1.0${qs}`))).json()) as { messages: { ts: string }[]; hasMore: boolean };
    expect(await get("&limit=2")).toEqual({ messages: [{ ts: "3.0" }, { ts: "4.0" }], hasMore: true });
    expect(await get("&limit=2&before=3.0")).toEqual({ messages: [{ ts: "1.0" }, { ts: "2.0" }], hasMore: false });
    expect((await get("")).messages).toHaveLength(4);
  });

  test("slack/search finds channels and DMs the sidebar did not load, and says 503 without Slack", async () => {
    expect((await build().dash.handle(api(`/api/slack/search?q=ops`))).status).toBe(503);
    const slack = {
      listMembers: async () => ({ members: [{ id: "U5", handle: "ann", realName: "Ann", displayName: "", title: "", email: "", avatar: "", deleted: false, isBot: false }] }),
      listConversationPage: async (what: "channels" | "dms") =>
        what === "channels"
          ? { conversations: [{ id: "C7", name: "ops-late", kind: "channel" as const }] }
          : { conversations: [{ id: "D5", name: "", kind: "im" as const, userId: "U5" }] },
    } as unknown as NonNullable<DashboardDeps["slack"]>;
    const { dash } = build({ slack });
    const found = async (q: string) => ((await (await dash.handle(api(`/api/slack/search?q=${q}`))).json()) as { conversations: { id: string; name: string; kind: string; lastActive: number }[] }).conversations;
    expect(await found("ops")).toEqual([{ id: "C7", name: "#ops-late", kind: "channel", lastActive: 0 }]);
    expect((await found("ann")).map((c) => [c.id, c.name])).toEqual([["D5", "@Ann"]]);
    expect(await found("")).toEqual([]);
  });

  test("slack/search answers empty when the port cannot list conversations, and 502 when Slack fails", async () => {
    const bare = build({ slack: {} as unknown as NonNullable<DashboardDeps["slack"]> });
    expect(await (await bare.dash.handle(api(`/api/slack/search?q=ops`))).json()).toEqual({ conversations: [] });
    const slack = { listConversationPage: async () => { throw new Error("ratelimited"); } } as unknown as NonNullable<DashboardDeps["slack"]>;
    expect((await build({ slack }).dash.handle(api(`/api/slack/search?q=ops`))).status).toBe(502);
  });

  test("the retired conversation routes are gone", async () => {
    const { dash } = build();
    expect((await dash.handle(api(`/api/conversations`))).status).toBe(404);
    expect((await dash.handle(api(`/api/conversation?channel=C1`))).status).toBe(404);
  });

  test("stats say they are not recording without a store, and chart the window with one", async () => {
    expect(await (await build().dash.handle(api(`/api/stats`))).json()).toEqual({ recording: false });
    const db = openDatabase(":memory:");
    const { createStatsRepo } = await import("../../src/infrastructure/db/statsRepo.ts");
    const { dash } = build({ stats: createStatsRepo(db), timezoneOffset: () => 0 });
    const out = (await (await dash.handle(api(`/api/stats?days=7`))).json()) as { recording: boolean; messages: unknown[] };
    expect(out.recording).toBe(true);
    expect(out.messages).toHaveLength(7);
  });

  test("member search goes through the Slack port, and refuses without one", async () => {
    expect((await build().dash.handle(api(`/api/slack/members?q=an`))).status).toBe(503);
    const slack = {
      listMembers: async () => ({
        members: [
          { id: "U5", handle: "ann", realName: "Ann", displayName: "annie", title: "PM", email: "", avatar: "", deleted: false, isBot: false },
          { id: "B1", handle: "annbot", realName: "Ann Bot", displayName: "", title: "", email: "", avatar: "", deleted: false, isBot: true },
        ],
      }),
    } as unknown as NonNullable<DashboardDeps["slack"]>;
    const res = await build({ slack }).dash.handle(api(`/api/slack/members?q=ann`));
    expect(await res.json()).toEqual({
      members: [{ id: "U5", handle: "ann", realName: "Ann", displayName: "annie", title: "PM", avatar: "" }],
    });
  });

  test("adding a picked person keeps the name shown", async () => {
    const { dash, users } = build();
    await dash.handle(postJson(`/api/users`, { slackId: "U321", role: "pal", displayName: "Picked Name" }));
    expect(users.get("U321")?.displayName).toBe("Picked Name");
  });

  test("avatars from Slack's CDN are allowed by the CSP", async () => {
    const res = await build().dash.handle(api(`/api/overview`));
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data: https://*.slack-edge.com");
  });
});

describe("dashboard roles over HTTP", () => {
  const withRoles = () => {
    const db = openDatabase(":memory:");
    const roleRepo = createRoleRepo(db);
    const settings = createSettingsRepo(db);
    seedRoles({
      repo: roleRepo,
      settings,
      clock: () => 1,
      legacyPolicies: () => [],
      input: () => ({ commands: listCommandInfo().map((c) => ({ name: c.name, minRole: c.minRole })), dbServers: [], executerDbServers: [], extraMcpServers: [] }),
    });
    return { ...build({ roleRepo }), roleRepo };
  };
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  test("GET /api/roles lists the owner (locked), the seeded roles and the permission catalogue", async () => {
    const d = withRoles();
    const view = (await json(await d.dash.handle(api("/api/roles")))) as { roles: { name: string; locked: boolean }[]; catalogue: { id: string }[]; editable: boolean };
    expect(view.roles.map((r) => r.name)).toEqual(["owner", "admin", "executer", "pal"]);
    expect(view.roles.find((r) => r.name === "owner")?.locked).toBe(true);
    expect(view.catalogue.some((p) => p.id === "github:pr-merge")).toBe(true);
    expect(view.editable).toBe(true);
  });

  test("save creates a role, rename and delete work, and the owner role and bad input are refused", async () => {
    const d = withRoles();
    const save = (body: Record<string, unknown>) => d.dash.handle(postJson("/api/roles/save", body));
    expect((await save({ name: "qa", from: "pal", description: "tests" })).status).toBe(200);
    expect(d.roleRepo.book.get("qa")?.grants).toContain("command:ping");
    expect((await save({ name: "owner", grants: [] })).status).toBe(400);
    expect((await save({ name: "qa", grants: ["command:role"] })).status).toBe(400);
    expect((await save({ name: "qa", grants: ["github:pr-merge", "command:ping"], rank: 1 })).status).toBe(200);
    expect(d.roleRepo.book.get("qa")?.grants).toEqual(["command:ping", "github:pr-merge"]);
    expect((await d.dash.handle(postJson("/api/roles/rename", { from: "qa", to: "testers" }))).status).toBe(200);
    expect(d.roleRepo.book.get("testers")).toBeDefined();
    d.users.upsert({ slackId: "U7", role: "testers", displayName: "", addedBy: "x", createdAt: 1 });
    const refused = await d.dash.handle(postJson("/api/roles/delete", { name: "testers" }));
    expect(refused.status).toBe(400);
    expect(((await json(refused)) as { error: string }).error).toContain("U7");
    d.users.remove("U7");
    expect((await d.dash.handle(postJson("/api/roles/delete", { name: "testers" }))).status).toBe(200);
    expect((await d.dash.handle(postJson("/api/roles/default", { name: "executer" }))).status).toBe(200);
    expect((await d.dash.handle(postJson("/api/roles/mcp-server", { server: "mcp__corp-wiki" }))).status).toBe(200);
    const view = (await json(await d.dash.handle(api("/api/roles")))) as { defaultRole: string; mcpServers: string[] };
    expect(view.defaultRole).toBe("executer");
    expect(view.mcpServers).toContain("corp-wiki");
  });

  test("a cross-origin POST cannot edit roles", async () => {
    const d = withRoles();
    const res = await d.dash.handle(postJson("/api/roles/save", { name: "qa" }, { origin: "http://evil.example" }));
    expect(res.status).toBe(403);
    expect(d.roleRepo.book.get("qa")).toBeUndefined();
  });

  test("without a role store nothing can be saved", async () => {
    const res = await build().dash.handle(postJson("/api/roles/save", { name: "qa" }));
    expect(res.status).toBe(503);
  });
});

describe("GET /api/slack/names", () => {
  const wired = () => {
    const asked = { users: [] as string[][], conversations: [] as string[] };
    const slack = {
      resolveNames: async (ids: readonly string[]) => {
        asked.users.push([...ids]);
        return Object.fromEntries(ids.filter((id) => id === "U1BBB").map((id) => [id, "Mai"]));
      },
      conversationInfo: async (id: string) => {
        asked.conversations.push(id);
        return id === "C1OPS" ? { kind: "channel" as const, name: "ops" } : id === "D1DM" ? { kind: "im" as const, userId: "U1BBB" } : undefined;
      },
    } as unknown as SlackAdminPort;
    return { asked, dash: build({ slack }).dash };
  };
  const names = async (dash: ReturnType<typeof wired>["dash"], qs: string) => {
    const res = await dash.handle(api(`/api/slack/names?${qs}`));
    return { status: res.status, body: (await res.json()) as { users: Record<string, string>; channels: Record<string, string> } };
  };

  test("one request names every mention; unknown ids map to empty, a stored allowlist name wins", async () => {
    const { dash, asked } = wired();
    const { status, body } = await names(dash, `users=${OWNER},U1BBB,U9ZZZ&channels=C1OPS,D1DM,C9NONE`);
    expect(status).toBe(200);
    expect(body).toEqual({ users: { [OWNER]: "Kai", U1BBB: "Mai", U9ZZZ: "" }, channels: { C1OPS: "ops", D1DM: "", C9NONE: "" } });
    // the owner is on the allowlist, so only the other two cost a users.info
    expect(asked.users).toEqual([["U1BBB", "U9ZZZ"]]);
  });

  test("answers are cached: asking again does not call Slack", async () => {
    const { dash, asked } = wired();
    await names(dash, "users=U1BBB&channels=C1OPS");
    await names(dash, "users=U1BBB&channels=C1OPS");
    expect(asked.users).toHaveLength(1);
    expect(asked.conversations).toEqual(["C1OPS"]);
  });

  test("malformed ids never reach Slack and an empty query is an empty answer", async () => {
    const { dash, asked } = wired();
    expect((await names(dash, "users=bad,<@U1BBB>,;drop&channels=%3Cx%3E")).body).toEqual({ users: {}, channels: {} });
    expect((await names(dash, "")).body).toEqual({ users: {}, channels: {} });
    expect(asked.users).toEqual([]);
    expect(asked.conversations).toEqual([]);
  });

  test("503 when the Slack console is not configured", async () => {
    expect((await build().dash.handle(api("/api/slack/names?users=U1BBB"))).status).toBe(503);
  });
});
