import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "../../src/application/botProfile.ts";
import { createDashboard } from "../../src/infrastructure/dashboard/server.ts";

const OWNER = "U0OWNER0001";
const TOKEN = "secret-token-secret-token-1234";

const build = () => {
  const db = openDatabase(":memory:");
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  const learnings = createLearningsRepo(db);
  const settings = createSettingsRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  const profile = () =>
    loadBotProfile(settings, { name: "TestBot", thinkingLabel: "thinking...", thinkingDoneLabel: "✅" });
  const dash = createDashboard(
    { port: 0, token: TOKEN, ownerSlackId: OWNER, model: "claude-opus-4-8", distDir: "/nonexistent" },
    { users, messages, learnings, settings, clock: () => 99, profile },
  );
  return { dash, users, messages, learnings, settings };
};

const api = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

describe("dashboard auth + static", () => {
  test("api rejects without a token", async () => {
    const res = await build().dash.handle(api("/api/overview"));
    expect(res.status).toBe(401);
  });

  test("health needs no token", async () => {
    const res = await build().dash.handle(api("/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("static falls back to a 500 hint when the build is missing", async () => {
    // distDir does not exist, so serveStatic reports the build is missing.
    const res = await build().dash.handle(api("/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("build");
  });

  test("sets security headers", async () => {
    const res = await build().dash.handle(api(`/api/overview?token=${TOKEN}`));
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("dashboard read API", () => {
  test("overview returns counts", async () => {
    const { dash, messages, learnings } = build();
    messages.append({ channelId: "C1", slackUserId: "U1", role: "user", content: "x" }, 1);
    learnings.add("l", "kai", 1);
    const res = await dash.handle(api(`/api/overview?token=${TOKEN}`));
    expect(await res.json()).toMatchObject({ users: 1, conversations: 1, messages: 1, learnings: 1 });
  });

  test("bootstrap exposes bot name and owner", async () => {
    const { dash } = build();
    expect(await (await dash.handle(api(`/api/bootstrap?token=${TOKEN}`))).json()).toMatchObject({
      botName: "TestBot",
      ownerSlackId: OWNER,
    });
  });

  test("identity returns persona + labels", async () => {
    const { dash } = build();
    const id = (await (await dash.handle(api(`/api/identity?token=${TOKEN}`))).json()) as {
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
    const res = await dash.handle(postJson(`/api/users?token=${TOKEN}`, { slackId: "U999", role: "admin" }));
    expect(res.status).toBe(200);
    expect(users.get("U999")?.role).toBe("admin");
  });

  test("rejects a malformed slack id", async () => {
    const res = await build().dash.handle(postJson(`/api/users?token=${TOKEN}`, { slackId: "nope" }));
    expect(res.status).toBe(400);
  });

  test("refuses to modify the owner", async () => {
    const { dash, users } = build();
    const res = await dash.handle(postJson(`/api/users?token=${TOKEN}`, { slackId: OWNER, role: "admin" }));
    expect(res.status).toBe(400);
    expect(users.get(OWNER)?.role).toBe("owner");
  });

  test("refuses to remove the owner", async () => {
    const { dash, users } = build();
    const res = await dash.handle(postJson(`/api/users/remove?token=${TOKEN}`, { slackId: OWNER }));
    expect(res.status).toBe(400);
    expect(users.get(OWNER)).toBeDefined();
  });

  test("rejects a cross-origin POST", async () => {
    const { dash, users } = build();
    const res = await dash.handle(
      postJson(`/api/users?token=${TOKEN}`, { slackId: "U777" }, { origin: "http://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(users.get("U777")).toBeUndefined();
  });

  test("allows a loopback origin that differs from the request host", async () => {
    const { dash, users } = build();
    const res = await dash.handle(
      new Request(`http://127.0.0.1/api/users?token=${TOKEN}`, {
        method: "POST",
        body: JSON.stringify({ slackId: "U444", role: "member" }),
        headers: { "content-type": "application/json", origin: "http://localhost:2001" },
      }),
    );
    expect(res.status).toBe(200);
    expect(users.get("U444")?.role).toBe("member");
  });

  test("learnings add/remove", async () => {
    const { dash, learnings } = build();
    await dash.handle(postJson(`/api/learnings?token=${TOKEN}`, { content: "staging is X" }));
    const [l] = learnings.list();
    expect(l?.content).toBe("staging is X");
    await dash.handle(postJson(`/api/learnings/remove?token=${TOKEN}`, { id: l!.id }));
    expect(learnings.list()).toHaveLength(0);
  });

  test("identity save sets name, labels and persona", async () => {
    const { dash, settings } = build();
    await dash.handle(
      postJson(`/api/identity?token=${TOKEN}`, {
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
    const res = await build().dash.handle(postJson(`/api/identity?token=${TOKEN}`, { name: "  " }));
    expect(res.status).toBe(400);
  });

  test("prompt reset clears the override", async () => {
    const { dash, settings } = build();
    settings.set(SETTING_KEYS.systemPrompt, "custom");
    await dash.handle(postJson(`/api/prompt/reset?token=${TOKEN}`, {}));
    expect(settings.get(SETTING_KEYS.systemPrompt)).toBeUndefined();
  });

  test("conversation clear wipes a channel", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C9", slackUserId: "U1", role: "user", content: "x" }, 1);
    await dash.handle(postJson(`/api/conversation/clear?token=${TOKEN}`, { channel: "C9" }));
    expect(messages.recentForChannel("C9", 10)).toHaveLength(0);
  });
});
