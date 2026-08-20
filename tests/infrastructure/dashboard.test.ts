import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/infrastructure/db/client.ts";
import { createUserRepo } from "../../src/infrastructure/db/userRepo.ts";
import { createMessageRepo } from "../../src/infrastructure/db/messageRepo.ts";
import { createDashboard } from "../../src/infrastructure/dashboard/server.ts";

const OWNER = "U0OWNER0001";
const TOKEN = "secret-token";

const build = () => {
  const db = openDatabase(":memory:");
  const users = createUserRepo(db);
  const messages = createMessageRepo(db);
  users.upsert({ slackId: OWNER, role: "owner", displayName: "Kai", addedBy: "system", createdAt: 1 });
  const dash = createDashboard(
    { port: 0, token: TOKEN, ownerSlackId: OWNER, model: "claude-opus-4-8" },
    { users, messages, clock: () => 99 },
  );
  return { dash, users };
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
    const form = new FormData();
    form.set("slackId", "U5");
    await dash.handle(req(`/api/users/remove?token=${TOKEN}`, { method: "POST", body: form }));
    expect(users.get("U5")).toBeUndefined();
  });
});
