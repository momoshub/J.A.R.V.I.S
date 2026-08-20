/**
 * Admin dashboard served with Bun.serve.
 *
 * Token-gated (query `?token=` or `X-Dashboard-Token` header). Lets the owner
 * eyeball E.V.'s state and manage the allowlist without touching Slack. The
 * request routing is a small pure-ish dispatcher; all storage goes through the
 * repos so the rules stay in one place.
 */
import type { UserRole } from "../../domain/types.ts";
import type { Clock } from "../../application/ports.ts";
import type { MessageRepo } from "../db/messageRepo.ts";
import type { UserRepo } from "../db/userRepo.ts";
import { renderDashboard } from "./views.ts";

export type DashboardConfig = {
  port: number;
  token: string;
  ownerSlackId: string;
  model: string;
};

export type DashboardDeps = {
  users: UserRepo;
  messages: MessageRepo;
  clock: Clock;
};

const SLACK_ID = /^[UW][A-Z0-9]+$/;

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const authorized = (req: Request, url: URL, token: string): boolean => {
  const provided = url.searchParams.get("token") ?? req.headers.get("x-dashboard-token") ?? "";
  return timingSafeEqual(provided, token);
};

const asRole = (v: string | null): UserRole =>
  v === "admin" ? "admin" : "member";

const redirect = (token: string): Response =>
  new Response(null, { status: 303, headers: { Location: `/?token=${encodeURIComponent(token)}` } });

export const createDashboard = (config: DashboardConfig, deps: DashboardDeps) => {
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    if (!authorized(req, url, config.token)) {
      return new Response("Unauthorized. Append ?token=...", { status: 401 });
    }

    // JSON read API
    if (url.pathname === "/api/users" && req.method === "GET") {
      return Response.json(deps.users.list());
    }
    if (url.pathname === "/api/stats" && req.method === "GET") {
      return Response.json({ users: deps.users.list().length, messages: deps.messages.count() });
    }

    // Mutations
    if (url.pathname === "/api/users" && req.method === "POST") {
      const form = await req.formData();
      const slackId = String(form.get("slackId") ?? "").trim();
      if (!SLACK_ID.test(slackId)) return new Response("Invalid Slack id", { status: 400 });
      const existing = deps.users.get(slackId);
      deps.users.upsert({
        slackId,
        role: asRole(form.get("role") as string | null),
        displayName: existing?.displayName ?? "",
        addedBy: "dashboard",
        createdAt: existing?.createdAt ?? deps.clock(),
      });
      return redirect(config.token);
    }

    if (url.pathname === "/api/users/remove" && req.method === "POST") {
      const form = await req.formData();
      const slackId = String(form.get("slackId") ?? "").trim();
      if (slackId === config.ownerSlackId) {
        return new Response("The owner cannot be removed", { status: 400 });
      }
      deps.users.remove(slackId);
      return redirect(config.token);
    }

    if (url.pathname === "/" && req.method === "GET") {
      const html = renderDashboard(
        {
          users: deps.users.list(),
          messageCount: deps.messages.count(),
          ownerSlackId: config.ownerSlackId,
          model: config.model,
        },
        config.token,
      );
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  };

  let server: { stop: () => void } | undefined;
  return {
    start: () => {
      server = Bun.serve({ port: config.port, fetch: handle });
      console.log(`[dashboard] E.V. control deck on http://localhost:${config.port}`);
    },
    stop: () => server?.stop(),
    // exposed for tests
    handle,
  };
};
