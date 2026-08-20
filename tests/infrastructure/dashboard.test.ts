import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createLearningsRepo } from "../../src/infrastructure/db/learningsRepo.ts";
import { createSettingsRepo, SETTING_KEYS } from "../../src/infrastructure/db/settingsRepo.ts";
import { loadBotProfile } from "../../src/application/botProfile.ts";
import { createDashboard } from "../../src/infrastructure/dashboard/server.ts";

const OWNER = "U0OWNER0001";
const TOKEN = "secret-token";

const build = () => {
  const db = openDatabase(":memory:");
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  const learnings = createLearningsRepo(db);
  const settings = createSettingsRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  const profile = () => loadBotProfile(settings, { name: "TestBot", thinkingLabel: "thinking..." });
  const dash = createDashboard(
    { port: 0, token: TOKEN, ownerSlackId: OWNER, model: "claude-opus-4-8" },
    { users, messages, learnings, settings, clock: () => 99, profile },
  );
  return { dash, users, messages, learnings, settings };
};

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const req = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

describe("dashboard auth", () => {
  test("rejects without a token", async () => {
    const { dash } = build();
    const res = await dash.handle(req("/"));
    expect(res.status).toBe(401);
  });

  test("health needs no token", async () => {
    const { dash } = build();
    const res = await dash.handle(req("/health"));
    expect(res.status).toBe(200);
  });

  test("serves html with a valid token", async () => {
    const { dash } = build();
    const res = await dash.handle(req(`/?token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("control deck");
  });
});

describe("dashboard mutations", () => {
  test("adds a user via form post", async () => {
    const { dash, users } = build();
    const form = new FormData();
    form.set("slackId", "U999");
    form.set("role", "admin");
    const res = await dash.handle(req(`/api/users?token=${TOKEN}`, { method: "POST", body: form }));
    expect(res.status).toBe(303);
    expect(users.get("U999")?.role).toBe("admin");
  });

  test("rejects a malformed slack id", async () => {
    const { dash } = build();
    const form = new FormData();
    form.set("slackId", "not-an-id");
    const res = await dash.handle(req(`/api/users?token=${TOKEN}`, { method: "POST", body: form }));
    expect(res.status).toBe(400);
  });

  test("refuses to remove the owner", async () => {
    const { dash, users } = build();
    const form = new FormData();
    form.set("slackId", OWNER);
    const res = await dash.handle(req(`/api/users/remove?token=${TOKEN}`, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect(users.get(OWNER)).toBeDefined();
  });

  test("refuses to modify the owner via add (no downgrade)", async () => {
    const { dash, users } = build();
    const form = new FormData();
    form.set("slackId", OWNER);
    form.set("role", "admin");
    const res = await dash.handle(req(`/api/users?token=${TOKEN}`, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect(users.get(OWNER)?.role).toBe("owner");
  });

  test("rejects a cross-origin POST", async () => {
    const { dash, users } = build();
    const form = new FormData();
    form.set("slackId", "U777");
    const res = await dash.handle(
      req(`/api/users?token=${TOKEN}`, {
        method: "POST",
        body: form,
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
    expect(users.get("U777")).toBeUndefined();
  });

  test("allows a loopback Origin that differs from the request host", async () => {
    // page served from localhost, Bun sees request host as 127.0.0.1 (or vice versa)
    const { dash, users } = build();
    const res = await dash.handle(
      new Request("http://127.0.0.1/api/users?token=" + TOKEN, {
        method: "POST",
        body: form({ slackId: "U444", role: "member" }),
        headers: { origin: "http://localhost:2001" },
      }),
    );
    expect(res.status).toBe(303);
    expect(users.get("U444")?.role).toBe("member");
  });

  test("sets security headers on responses", async () => {
    const { dash } = build();
    const res = await dash.handle(req(`/?token=${TOKEN}`));
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("removes a non-owner user", async () => {
    const { dash, users } = build();
    users.upsert({ slackId: "U5", role: "member", displayName: "", addedBy: "x", createdAt: 1 });
    await dash.handle(
      req(`/api/users/remove?token=${TOKEN}`, { method: "POST", body: form({ slackId: "U5" }) }),
    );
    expect(users.get("U5")).toBeUndefined();
  });
});

describe("dashboard learnings", () => {
  test("adds and lists a learning", async () => {
    const { dash, learnings } = build();
    const res = await dash.handle(
      req(`/api/learnings?token=${TOKEN}`, { method: "POST", body: form({ content: "staging is X" }) }),
    );
    expect(res.status).toBe(303);
    expect(learnings.list().map((l) => l.content)).toEqual(["staging is X"]);
  });

  test("rejects an empty learning", async () => {
    const { dash } = build();
    const res = await dash.handle(
      req(`/api/learnings?token=${TOKEN}`, { method: "POST", body: form({ content: "  " }) }),
    );
    expect(res.status).toBe(400);
  });

  test("removes a learning by id", async () => {
    const { dash, learnings } = build();
    const l = learnings.add("temp", "test", 1);
    await dash.handle(
      req(`/api/learnings/remove?token=${TOKEN}`, { method: "POST", body: form({ id: String(l.id) }) }),
    );
    expect(learnings.list()).toHaveLength(0);
  });

  test("renders learnings on the page", async () => {
    const { dash, learnings } = build();
    learnings.add("remember the milk", "kai", 1);
    const res = await dash.handle(req(`/learnings?token=${TOKEN}`));
    expect(await res.text()).toContain("remember the milk");
  });
});

describe("dashboard prompt editor", () => {
  test("shows the default persona when no override", async () => {
    const { dash } = build();
    const res = await dash.handle(req(`/prompt?token=${TOKEN}`));
    const body = await res.text();
    expect(body).toContain("built-in default persona");
    expect(body).toContain("friendly, calm and helpful");
  });

  test("saves identity (name, thinking label, persona) and reflects it", async () => {
    const { dash, settings } = build();
    await dash.handle(
      req(`/api/identity?token=${TOKEN}`, {
        method: "POST",
        body: form({ name: "Evie", thinkingLabel: "☄️ burning", prompt: "You are terse." }),
      }),
    );
    expect(settings.get(SETTING_KEYS.botName)).toBe("Evie");
    expect(settings.get(SETTING_KEYS.thinkingLabel)).toBe("☄️ burning");
    expect(settings.get(SETTING_KEYS.systemPrompt)).toBe("You are terse.");
    const body = await (await dash.handle(req(`/prompt?token=${TOKEN}`))).text();
    expect(body).toContain("custom persona");
    expect(body).toContain("You are terse.");
    expect(body).toContain("Evie");
  });

  test("identity save requires a name", async () => {
    const { dash } = build();
    const res = await dash.handle(
      req(`/api/identity?token=${TOKEN}`, { method: "POST", body: form({ name: "  " }) }),
    );
    expect(res.status).toBe(400);
  });

  test("reset clears the persona override", async () => {
    const { dash, settings } = build();
    settings.set(SETTING_KEYS.systemPrompt, "custom");
    await dash.handle(req(`/api/prompt/reset?token=${TOKEN}`, { method: "POST", body: form({}) }));
    expect(settings.get(SETTING_KEYS.systemPrompt)).toBeUndefined();
  });

  test("bot name from settings appears in the page title/header", async () => {
    const { dash, settings } = build();
    settings.set(SETTING_KEYS.botName, "Evie");
    const body = await (await dash.handle(req(`/?token=${TOKEN}`))).text();
    expect(body).toContain("Evie");
  });
});

describe("dashboard conversations", () => {
  test("lists channels and renders a conversation", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C1", slackUserId: OWNER, role: "user", content: "hello world" }, 10);
    messages.append({ channelId: "C1", slackUserId: OWNER, role: "assistant", content: "hi back" }, 11);
    const list = await dash.handle(req(`/conversations?token=${TOKEN}`));
    expect(await list.text()).toContain("C1");
    const convo = await dash.handle(req(`/conversation?channel=C1&token=${TOKEN}`));
    const body = await convo.text();
    expect(body).toContain("hello world");
    expect(body).toContain("hi back");
  });

  test("clears a channel's memory", async () => {
    const { dash, messages } = build();
    messages.append({ channelId: "C9", slackUserId: OWNER, role: "user", content: "x" }, 1);
    const res = await dash.handle(
      req(`/api/conversation/clear?token=${TOKEN}`, { method: "POST", body: form({ channel: "C9" }) }),
    );
    expect(res.status).toBe(303);
    expect(messages.recentForChannel("C9", 10)).toHaveLength(0);
  });
});
