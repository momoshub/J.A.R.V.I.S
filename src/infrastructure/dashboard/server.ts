/**
 * Admin dashboard server (Bun.serve), bound to loopback.
 *
 * Serves a React single-page app (built to `distDir`) plus a JSON API under
 * `/api`. It is a local, loopback-only tool with no token auth - the only guard
 * on mutations is a same-origin/allow-listed Origin check (CSRF) that needs no
 * user action. Mutations still refuse to touch the owner record.
 */
import { join, normalize } from "node:path";
import type { UserRole } from "../../domain/types.ts";
import { DEFAULT_PERSONALITY } from "../../domain/personality.ts";
import type { BotProfile } from "../../application/botProfile.ts";
import type { SlackAdminPort } from "../../application/slackAdmin.ts";
import type { DraftReply } from "../../application/draftReply.ts";
import { listCommandInfo } from "../../application/commands.ts";
import { PAL_TOOLS } from "../../domain/toolPolicy.ts";
import type { Clock } from "../../application/ports.ts";
import type { CommandLogRepo } from "../db/commandLogRepo.ts";
import type { MessageRepo } from "../db/messageRepo.ts";
import type { UserRepo } from "../db/userRepo.ts";
import type { LearningsRepo } from "../db/learningsRepo.ts";
import { SETTING_KEYS, type SettingsRepo } from "../db/settingsRepo.ts";

export type DashboardConfig = {
  port: number;
  ownerSlackId: string;
  model: string;
  commandPrefix: string;
  slashCommand: string;
  /** Directory of the built React app (index.html + assets). */
  distDir: string;
  /** Extra browser origins allowed to POST (for proxy/tunnel access). */
  allowedOrigins?: readonly string[];
};

export type DashboardDeps = {
  users: UserRepo;
  messages: MessageRepo;
  learnings: LearningsRepo;
  settings: SettingsRepo;
  clock: Clock;
  /** Current bot identity, for the header and identity editor. */
  profile: () => BotProfile;
  /** Slack Web API operations for the console (may be absent if not wired). */
  slack?: SlackAdminPort;
  /** Generate an AI reply draft from a thread. */
  draft?: DraftReply;
  /** Command execution audit log. */
  commandLog?: CommandLogRepo;
};

const parseCsv = (v: string | undefined): Set<string> =>
  new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const SLACK_ID = /^[UW][A-Z0-9]+$/;
const CONVERSATION_LIMIT = 200;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * CSRF guard for a loopback-bound tool. A cross-site attacker's Origin is its own
 * domain, so we allow no Origin, an exact match, a loopback Origin, or a
 * configured allowed Origin.
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

const asRole = (v: unknown): UserRole => (v === "admin" ? "admin" : "pal");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[path.slice(dot)]) || "application/octet-stream";
};

// SPA needs its own bundle + inline module preloads; keep everything same-origin.
const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const withHeaders = (res: Response): Response => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
};

export const createDashboard = (config: DashboardConfig, deps: DashboardDeps) => {
  const jsonError = (message: string, status = 400) => Response.json({ error: message }, { status });

  /** Run a Slack Web API call, surfacing scope/API errors as JSON to the client. */
  const slackGuard = async (fn: () => Promise<unknown>): Promise<Response> => {
    if (!deps.slack) return jsonError("Slack console is not configured", 503);
    try {
      return Response.json(await fn());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : String(e), 502);
    }
  };

  /** Serve a static file from distDir, falling back to index.html (SPA routing). */
  const serveStatic = async (pathname: string): Promise<Response> => {
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
    const candidate = rel === "" ? "index.html" : rel;
    const file = Bun.file(join(config.distDir, candidate));
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": contentTypeFor(candidate) } });
    }
    const index = Bun.file(join(config.distDir, "index.html"));
    if (await index.exists()) {
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Dashboard build missing. Run `bun run build:web`.", { status: 500 });
  };

  const api = async (req: Request, url: URL): Promise<Response> => {
    if (req.method === "GET") {
      switch (url.pathname) {
        case "/api/bootstrap":
          return Response.json({
            botName: deps.profile().name,
            ownerSlackId: config.ownerSlackId,
            model: config.model,
            commandPrefix: config.commandPrefix,
            slashCommand: config.slashCommand,
          });
        case "/api/overview":
          return Response.json({
            users: deps.users.list().length,
            conversations: deps.messages.channels().length,
            messages: deps.messages.count(),
            learnings: deps.learnings.list().length,
          });
        case "/api/users": {
          const users = deps.users.list();
          // Dual display: fill in a Slack-resolved name where we have no stored one.
          const missing = users.filter((u) => !u.displayName).map((u) => u.slackId);
          const resolved: Record<string, string> =
            missing.length && deps.slack ? await deps.slack.resolveNames(missing).catch(() => ({})) : {};
          return Response.json(
            users.map((u) => ({ ...u, name: u.displayName || resolved[u.slackId] || "" })),
          );
        }
        case "/api/roles":
          return Response.json({
            executerTools: deps.settings.get(SETTING_KEYS.executerTools) ?? "",
            palTools: PAL_TOOLS,
          });
        case "/api/learnings":
          return Response.json(deps.learnings.list());
        case "/api/identity": {
          const override = deps.settings.get(SETTING_KEYS.systemPrompt);
          const p = deps.profile();
          return Response.json({
            name: p.name,
            thinkingLabel: p.thinkingLabel,
            thinkingDoneLabel: p.thinkingDoneLabel,
            persona: override ?? DEFAULT_PERSONALITY,
            usingDefault: override === undefined,
            defaultPersona: DEFAULT_PERSONALITY,
          });
        }
        case "/api/commands":
          return Response.json({
            commands: listCommandInfo(),
            disabled: [...parseCsv(deps.settings.get(SETTING_KEYS.disabledCommands))],
          });
        case "/api/command-log":
          return Response.json(deps.commandLog?.recent(200) ?? []);
        case "/api/conversations":
          return Response.json(deps.messages.channels());
        case "/api/conversation": {
          const channel = url.searchParams.get("channel") ?? "";
          return Response.json(
            channel ? deps.messages.recentForChannel(channel, CONVERSATION_LIMIT) : [],
          );
        }
        // --- Slack console (live Slack Web API) ---
        case "/api/slack/conversations":
          return slackGuard(() => deps.slack!.listConversations());
        case "/api/slack/history": {
          const channel = url.searchParams.get("channel") ?? "";
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
          const cursor = url.searchParams.get("cursor") || undefined;
          return slackGuard(() => deps.slack!.history(channel, limit, cursor));
        }
        case "/api/slack/thread": {
          const channel = url.searchParams.get("channel") ?? "";
          const ts = url.searchParams.get("ts") ?? "";
          return slackGuard(() => deps.slack!.replies(channel, ts));
        }
      }
      return jsonError("Not found", 404);
    }

    if (req.method === "POST") {
      if (!originAllowed(req, url, config.allowedOrigins ?? [])) {
        const origin = req.headers.get("origin") ?? "(none)";
        console.warn(
          `[dashboard] blocked cross-origin POST from ${origin} (expected ${url.origin}). ` +
            `If this is your dashboard, add its origin to DASHBOARD_ALLOWED_ORIGINS.`,
        );
        return jsonError("Cross-origin request rejected (see server log; set DASHBOARD_ALLOWED_ORIGINS).", 403);
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

      switch (url.pathname) {
        case "/api/users": {
          const slackId = String(body.slackId ?? "").trim();
          if (!SLACK_ID.test(slackId)) return jsonError("Invalid Slack id");
          if (slackId === config.ownerSlackId) return jsonError("The owner record cannot be modified");
          const existing = deps.users.get(slackId);
          deps.users.upsert({
            slackId,
            role: asRole(body.role),
            displayName: existing?.displayName ?? "",
            addedBy: "dashboard",
            createdAt: existing?.createdAt ?? deps.clock(),
          });
          return Response.json({ ok: true });
        }
        case "/api/users/remove": {
          const slackId = String(body.slackId ?? "").trim();
          if (slackId === config.ownerSlackId) return jsonError("The owner cannot be removed");
          deps.users.remove(slackId);
          return Response.json({ ok: true });
        }
        case "/api/learnings": {
          const content = String(body.content ?? "").trim();
          if (!content) return jsonError("Empty learning");
          deps.learnings.add(content, "dashboard", deps.clock());
          return Response.json({ ok: true });
        }
        case "/api/learnings/remove": {
          const id = Number(body.id);
          if (!Number.isInteger(id)) return jsonError("Invalid id");
          deps.learnings.remove(id);
          return Response.json({ ok: true });
        }
        case "/api/identity": {
          const name = String(body.name ?? "").trim();
          if (!name) return jsonError("Bot name is required");
          deps.settings.set(SETTING_KEYS.botName, name);
          const setOrClear = (key: string, value: unknown) => {
            const v = String(value ?? "").trim();
            if (v) deps.settings.set(key, v);
            else deps.settings.remove(key);
          };
          setOrClear(SETTING_KEYS.thinkingLabel, body.thinkingLabel);
          setOrClear(SETTING_KEYS.thinkingDoneLabel, body.thinkingDoneLabel);
          const prompt = String(body.prompt ?? "").trim();
          if (prompt) deps.settings.set(SETTING_KEYS.systemPrompt, prompt);
          return Response.json({ ok: true });
        }
        case "/api/prompt/reset": {
          deps.settings.remove(SETTING_KEYS.systemPrompt);
          return Response.json({ ok: true });
        }
        case "/api/conversation/clear": {
          const channel = String(body.channel ?? "").trim();
          if (channel) deps.messages.clearChannel(channel);
          return Response.json({ ok: true });
        }

        case "/api/commands/toggle": {
          const name = String(body.name ?? "").trim();
          if (!name) return jsonError("Command name required");
          const disabled = parseCsv(deps.settings.get(SETTING_KEYS.disabledCommands));
          if (body.enabled === false) disabled.add(name);
          else disabled.delete(name);
          deps.settings.set(SETTING_KEYS.disabledCommands, [...disabled].join(","));
          return Response.json({ ok: true });
        }
        case "/api/command-log/clear":
          deps.commandLog?.clear();
          return Response.json({ ok: true });

        case "/api/roles": {
          // Assign the executer role's tool allow-list (comma/newline separated).
          deps.settings.set(SETTING_KEYS.executerTools, String(body.executerTools ?? "").trim());
          return Response.json({ ok: true });
        }

        // --- Slack console mutations ---
        case "/api/slack/update":
          return slackGuard(async () => {
            await deps.slack!.update(String(body.channel), String(body.ts), String(body.text ?? ""));
            return { ok: true };
          });
        case "/api/slack/delete":
          return slackGuard(async () => {
            await deps.slack!.remove(String(body.channel), String(body.ts));
            return { ok: true };
          });
        case "/api/slack/post":
          return slackGuard(async () => {
            const text = String(body.text ?? "").trim();
            if (!text) throw new Error("Message is empty");
            const threadTs = body.threadTs ? String(body.threadTs) : undefined;
            await deps.slack!.post(String(body.channel), text, threadTs);
            return { ok: true };
          });
        case "/api/slack/draft":
          return slackGuard(async () => {
            if (!deps.draft) throw new Error("Drafting is not configured");
            const channel = String(body.channel ?? "");
            const threadTs = body.threadTs ? String(body.threadTs) : undefined;
            const thread = threadTs
              ? await deps.slack!.replies(channel, threadTs)
              : (await deps.slack!.history(channel, 15)).messages;
            return { draft: await deps.draft(thread) };
          });
      }
      return jsonError("Not found", 404);
    }

    return jsonError("Method not allowed", 405);
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(req, url);
    if (req.method === "GET") return serveStatic(url.pathname);
    return new Response("Not found", { status: 404 });
  };

  const handle = async (req: Request): Promise<Response> =>
    withHeaders(await route(req, new URL(req.url)));

  let server: { stop: () => void } | undefined;
  return {
    start: () => {
      server = Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: handle });
      console.log(`[dashboard] ${deps.profile().name} control deck on http://localhost:${config.port}`);
    },
    stop: () => server?.stop(),
    handle,
  };
};
