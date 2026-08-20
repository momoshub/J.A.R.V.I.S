/**
 * Admin dashboard served with Bun.serve.
 *
 * Token-gated (query `?token=` or `X-Dashboard-Token` header) and bound to
 * loopback only. The owner can browse conversations, curate learnings, edit
 * E.V.'s system prompt, and manage the allowlist. All storage goes through the
 * repos so the rules stay in one place; the dashboard token represents
 * owner-level authority, so mutations still refuse to touch the owner record.
 */
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { UserRole } from "../../domain/types.ts";
import { DEFAULT_PERSONALITY } from "../../domain/personality.ts";
import type { Clock } from "../../application/ports.ts";
import type { MessageRepo } from "../db/messageRepo.ts";
import type { UserRepo } from "../db/userRepo.ts";
import type { LearningsRepo } from "../db/learningsRepo.ts";
import { SETTING_KEYS, type SettingsRepo } from "../db/settingsRepo.ts";
import {
  layout,
  renderConversation,
  renderConversations,
  renderLearnings,
  renderOverview,
  renderPrompt,
  renderUsers,
} from "./views.ts";

export type DashboardConfig = {
  port: number;
  token: string;
  ownerSlackId: string;
  model: string;
  /** Extra browser origins allowed to POST (for proxy/tunnel access). */
  allowedOrigins?: readonly string[];
};

export type DashboardDeps = {
  users: UserRepo;
  messages: MessageRepo;
  learnings: LearningsRepo;
  settings: SettingsRepo;
  clock: Clock;
};

const SLACK_ID = /^[UW][A-Z0-9]+$/;
const CONVERSATION_LIMIT = 200;

const tokensMatch = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && cryptoTimingSafeEqual(ab, bb);
};

const authorized = (req: Request, url: URL, token: string): boolean => {
  const provided = url.searchParams.get("token") ?? req.headers.get("x-dashboard-token") ?? "";
  return tokensMatch(provided, token);
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * CSRF guard for a token-gated, loopback-bound tool. A cross-site attacker's
 * Origin is its own domain and it does not have the token anyway, so we allow
 * requests with no Origin, an exact match, a loopback Origin, or a configured
 * allowed Origin. Loopback tolerance covers the benign localhost vs 127.0.0.1
 * mismatch; the allow-list covers proxy/tunnel/port-forward access.
 */
const originAllowed = (req: Request, url: URL, allowed: readonly string[]): boolean => {
  const origin = req.headers.get("origin");
  if (origin === null || origin === url.origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

const asRole = (v: string | null): UserRole => (v === "admin" ? "admin" : "member");

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

const html = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

export const createDashboard = (config: DashboardConfig, deps: DashboardDeps) => {
  const subtitle = `model: ${config.model} - owner: <code>${config.ownerSlackId}</code>`;
  const redirect = (path: string): Response =>
    new Response(null, {
      status: 303,
      headers: { Location: `${path}?token=${encodeURIComponent(config.token)}` },
    });

  const page = (active: Parameters<typeof layout>[0]["active"], title: string, body: string) =>
    html(layout({ title: `E.V. - ${title}`, active, subtitle, body, token: config.token }));

  const route = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/health") return Response.json({ ok: true });

    if (!authorized(req, url, config.token)) {
      return new Response("Unauthorized. Append ?token=...", { status: 401 });
    }

    // --- read JSON API ---
    if (url.pathname === "/api/users" && req.method === "GET") {
      return Response.json(deps.users.list());
    }
    if (url.pathname === "/api/stats" && req.method === "GET") {
      return Response.json({
        users: deps.users.list().length,
        messages: deps.messages.count(),
        learnings: deps.learnings.list().length,
        channels: deps.messages.channels().length,
      });
    }

    // --- pages ---
    if (req.method === "GET") {
      switch (url.pathname) {
        case "/":
          return page(
            "overview",
            "Overview",
            renderOverview({
              userCount: deps.users.list().length,
              messageCount: deps.messages.count(),
              learningCount: deps.learnings.list().length,
              channelCount: deps.messages.channels().length,
            }),
          );
        case "/users":
          return page("users", "Users", renderUsers(deps.users.list(), config.ownerSlackId, config.token));
        case "/learnings":
          return page("learnings", "Learnings", renderLearnings(deps.learnings.list(), config.token));
        case "/prompt": {
          const override = deps.settings.get(SETTING_KEYS.systemPrompt);
          return page(
            "prompt",
            "Prompt",
            renderPrompt(
              { current: override ?? DEFAULT_PERSONALITY, usingDefault: override === undefined },
              config.token,
            ),
          );
        }
        case "/conversations":
          return page("conversations", "Conversations", renderConversations(deps.messages.channels(), config.token));
        case "/conversation": {
          const channel = url.searchParams.get("channel") ?? "";
          const messages = channel ? deps.messages.recentForChannel(channel, CONVERSATION_LIMIT) : [];
          return page("conversations", "Conversation", renderConversation({ channelId: channel, messages }, config.token));
        }
      }
    }

    // --- mutations (same-origin only) ---
    if (req.method === "POST") {
      if (!originAllowed(req, url, config.allowedOrigins ?? [])) {
        const origin = req.headers.get("origin") ?? "(none)";
        console.warn(
          `[dashboard] blocked cross-origin POST from ${origin} (expected ${url.origin}). ` +
            `If this is your dashboard, add it to DASHBOARD_ALLOWED_ORIGINS.`,
        );
        return new Response(
          `Forbidden: request Origin ${origin} is not allowed (server expected ${url.origin}). ` +
            `Add ${origin} to DASHBOARD_ALLOWED_ORIGINS in .env to permit it.`,
          { status: 403 },
        );
      }
      const form = await req.formData();

      switch (url.pathname) {
        case "/api/users": {
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
          return redirect("/users");
        }

        case "/api/users/remove": {
          const slackId = String(form.get("slackId") ?? "").trim();
          if (slackId === config.ownerSlackId) {
            return new Response("The owner cannot be removed", { status: 400 });
          }
          deps.users.remove(slackId);
          return redirect("/users");
        }

        case "/api/learnings": {
          const content = String(form.get("content") ?? "").trim();
          if (!content) return new Response("Empty learning", { status: 400 });
          deps.learnings.add(content, "dashboard", deps.clock());
          return redirect("/learnings");
        }

        case "/api/learnings/remove": {
          const id = Number(form.get("id"));
          if (!Number.isInteger(id)) return new Response("Invalid id", { status: 400 });
          deps.learnings.remove(id);
          return redirect("/learnings");
        }

        case "/api/prompt": {
          const prompt = String(form.get("prompt") ?? "").trim();
          if (!prompt) return new Response("Empty prompt", { status: 400 });
          deps.settings.set(SETTING_KEYS.systemPrompt, prompt);
          return redirect("/prompt");
        }

        case "/api/prompt/reset": {
          deps.settings.remove(SETTING_KEYS.systemPrompt);
          return redirect("/prompt");
        }

        case "/api/conversation/clear": {
          const channel = String(form.get("channel") ?? "").trim();
          if (channel) deps.messages.clearChannel(channel);
          return redirect("/conversations");
        }
      }
    }

    return new Response("Not found", { status: 404 });
  };

  const handle = async (req: Request): Promise<Response> =>
    withHeaders(await route(req, new URL(req.url)));

  let server: { stop: () => void } | undefined;
  return {
    start: () => {
      server = Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: handle });
      console.log(`[dashboard] E.V. control deck on http://localhost:${config.port}`);
    },
    stop: () => server?.stop(),
    handle,
  };
};
