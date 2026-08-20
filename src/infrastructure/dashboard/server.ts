/**
 * Admin dashboard served with Bun.serve.
 *
 * Token-gated (query `?token=` or `X-Dashboard-Token` header) and bound to
 * loopback only. Lets the owner eyeball E.V.'s state and manage the allowlist
 * without touching Slack. The request routing is a small dispatcher; all storage
 * goes through the repos so the rules stay in one place. The dashboard token
 * represents owner-level authority, so mutations here still refuse to touch the
 * owner record.
 */
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
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

/** Constant-time string compare via the platform primitive. */
const tokensMatch = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && cryptoTimingSafeEqual(ab, bb);
};

const authorized = (req: Request, url: URL, token: string): boolean => {
  const provided = url.searchParams.get("token") ?? req.headers.get("x-dashboard-token") ?? "";
  return tokensMatch(provided, token);
};

/** Reject cross-site state-changing requests (basic CSRF defense). */
const sameOrigin = (req: Request, url: URL): boolean => {
  const origin = req.headers.get("origin");
  return origin === null || origin === url.origin;
};

const asRole = (v: string | null): UserRole => (v === "admin" ? "admin" : "member");

// Strict headers on every response: no referrer leak of the token, no framing,
// and a locked-down CSP (inline styles only, forms post to self, no scripts).
const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const withHeaders = (res: Response): Response => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
};

const redirectHome = (token: string): Response =>
  new Response(null, {
    status: 303,
    headers: { Location: `/?token=${encodeURIComponent(token)}` },
  });

export const createDashboard = (config: DashboardConfig, deps: DashboardDeps) => {
  const route = async (req: Request, url: URL): Promise<Response> => {
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

    // Mutations - require a same-origin request.
    if (url.pathname === "/api/users" && req.method === "POST") {
      if (!sameOrigin(req, url)) return new Response("Forbidden", { status: 403 });
      const form = await req.formData();
      const slackId = String(form.get("slackId") ?? "").trim();
      if (!SLACK_ID.test(slackId)) return new Response("Invalid Slack id", { status: 400 });
      if (slackId === config.ownerSlackId) {
        return new Response("The owner record cannot be modified", { status: 400 });
      }
      const existing = deps.users.get(slackId);
      deps.users.upsert({
        slackId,
        role: asRole(form.get("role") as string | null),
        displayName: existing?.displayName ?? "",
        addedBy: "dashboard",
        createdAt: existing?.createdAt ?? deps.clock(),
      });
      return redirectHome(config.token);
    }

    if (url.pathname === "/api/users/remove" && req.method === "POST") {
      if (!sameOrigin(req, url)) return new Response("Forbidden", { status: 403 });
      const form = await req.formData();
      const slackId = String(form.get("slackId") ?? "").trim();
      if (slackId === config.ownerSlackId) {
        return new Response("The owner cannot be removed", { status: 400 });
      }
      deps.users.remove(slackId);
      return redirectHome(config.token);
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

  const handle = async (req: Request): Promise<Response> =>
    withHeaders(await route(req, new URL(req.url)));

  let server: { stop: () => void } | undefined;
  return {
    start: () => {
      // Loopback only - never expose the allowlist manager to the LAN.
      server = Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: handle });
      console.log(`[dashboard] E.V. control deck on http://localhost:${config.port}`);
    },
    stop: () => server?.stop(),
    // exposed for tests
    handle,
  };
};
