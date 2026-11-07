/**
 * Admin dashboard server (Bun.serve), bound to loopback.
 *
 * Serves a React single-page app (built to `distDir`) plus a JSON API under
 * `/api`. It is a local, loopback-only tool with no token auth - the only guard
 * on mutations is a same-origin/allow-listed Origin check (CSRF) that needs no
 * user action. Mutations still refuse to touch the owner record.
 */
import { join, normalize } from "node:path";
import { describeConnection, isListening, type ConnectionHealth } from "../../domain/connectionHealth.ts";
import { describeUiAccess, type UiAccess } from "../../domain/uiAccess.ts";
import type { UserRole } from "../../domain/types.ts";
import { DEFAULT_PERSONALITY } from "../../domain/personality.ts";
import type { BotProfile } from "../../application/botProfile.ts";
import type { SlackAdminPort } from "../../application/slackAdmin.ts";
import type { DraftReply } from "../../application/draftReply.ts";
import { listCommandInfo } from "../../application/commands.ts";
import { PAL_TOOLS } from "../../domain/toolPolicy.ts";
import type { Clock } from "../../application/ports.ts";
import type { CommandLogRepo } from "../db/commandLogRepo.ts";
import type { UsageRepo } from "../db/usageRepo.ts";
import type { MessageRepo } from "../db/messageRepo.ts";
import type { UserRepo } from "../db/userRepo.ts";
import type { LearningsRepo } from "../db/learningsRepo.ts";
import type { KitViewRepo } from "../db/kitViewRepo.ts";
import { KIT_MODAL_PREFIX, viewProblem, type KitView } from "../../domain/kitEvents.ts";
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
  /**
   * The memory adapter, when one is configured.
   *
   * `remember` is what the brain's own save endpoint writes through, so a fact
   * it decides to keep mid-conversation lands in the adapter rather than the
   * old table. `status` backs a read-only view of what it currently holds.
   */
  adapter?: {
    readonly status: () => string;
    /** Everything the memory page renders, read-only. */
    readonly view: () => {
      readonly policy: string;
      readonly notes: string;
      readonly skills: readonly { readonly name: string; readonly description: string }[];
      readonly people: readonly string[];
      readonly channels: readonly string[];
      readonly revisions: readonly {
        readonly id: number;
        readonly createdAt: number;
        readonly createdBy: string;
        readonly reason: string;
      }[];
      readonly items: number;
    };
    readonly remember: (
      content: string,
      by: string,
    ) => { readonly ok: boolean; readonly violations?: readonly string[]; readonly warnings?: readonly string[] };
    readonly revert: (
      id: number,
      by: string,
    ) => { readonly ok: boolean; readonly violations?: readonly string[] };
  };
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
  /** What each run of the model consumed, for the spend page. */
  usage?: UsageRepo;
  /**
   * Whether the bot can currently hear Slack. Read through a getter because the
   * Slack app is built after this server; "deaf" must be visible from outside
   * the process, since from inside it looks exactly like a quiet afternoon.
   */
  slackHealth?: () => ConnectionHealth | undefined;
  /**
   * Whether the bot may drive the desktop UI. Reported, never fatal: almost
   * nothing needs it, which is why its absence otherwise goes unnoticed for
   * weeks.
   */
  uiAccess?: () => Promise<{ access: UiAccess; checkedAt: number }>;
  /**
   * Run one of the bot's own commands on someone's behalf. Wired in the
   * composition root, where the full command dependencies live; the brain
   * reaches it through this endpoint when a chat request is really a command.
   */
  runCommand?: (req: RunCommandRequest) => Promise<{ result: string; posted: boolean }>;
  /**
   * Post a turn's answer to GitHub as the GitHub App. Same ticket as
   * `runCommand`: the thread it resolves to decides which issue may be written.
   */
  githubComment?: (req: { ticket: string; repo: string; number: number; body: string }) => Promise<{ url?: string }>;
  /** Modals the brain stores for a `jv:modal:<id>` button to open on click. */
  kitViews?: KitViewRepo;
  /**
   * Exit so the supervisor restarts us, after a delay long enough for the reply
   * that asked for it to land. Absent means self-restart is not wired up.
   */
  requestRestart?: (reason: string) => void;
  /**
   * True while a restart waits for running turns. The bot is not reading the
   * inbox then, so `/health` must not claim it is listening.
   */
  draining?: () => boolean;
};

/**
 * One command asked for from outside the Slack transport. The ticket carries
 * who it runs as - deliberately not the caller, who may be a sandboxed session
 * that would otherwise be able to name anyone.
 */
export type RunCommandRequest = {
  ticket: string;
  /** The command line, e.g. `review https://github.com/o/r/pull/1`. */
  line: string;
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
            // With an adapter the old table is empty by design, so count what
            // memory actually holds rather than reporting a truthful zero.
            learnings: deps.adapter ? deps.adapter.view().items : deps.learnings.list().length,
            memory: !!deps.adapter,
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
        case "/api/adapter":
          // Editing is `adapter refine`, which is gated and recorded as a
          // revision. A grid of text boxes writing straight into memory is
          // the thing this whole change exists to remove - so the page shows
          // what is there, and the two safe actions: teach, and revert.
          return deps.adapter
            ? Response.json({ configured: true, status: deps.adapter.status(), ...deps.adapter.view() })
            : Response.json({ configured: false });
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
        case "/api/usage": {
          // One window per request: the page asks for the one it is showing,
          // rather than the server guessing and the two disagreeing.
          if (!deps.usage) return Response.json({ recording: false });
          const hours = Number(url.searchParams.get("hours") ?? "24");
          const windowMs = (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 24) * 3_600_000;
          const since = deps.clock() - windowMs;
          const names = Object.fromEntries(
            deps.users.list().map((u) => [u.slackId, u.displayName || u.slackId]),
          );
          return Response.json({
            recording: true,
            windowMs,
            totals: deps.usage.totals(since),
            byUser: deps.usage.byUser(since, 25),
            byKind: deps.usage.byKind(since, 25),
            names,
          });
        }
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
        case "/api/kit/views": {
          // The brain cannot open a modal from a turn, so it stores one here
          // and posts a button naming it. Shape is checked now, not on click,
          // where a bad view could only fail silently in front of someone.
          if (!deps.kitViews) return jsonError("Modals are not wired up", 503);
          const problem = viewProblem(body.view);
          if (problem) return jsonError(problem);
          const id = deps.kitViews.save(body.view as KitView, deps.clock());
          return Response.json({ ok: true, id, action_id: `${KIT_MODAL_PREFIX}${id}` });
        }
        case "/api/learnings": {
          const content = String(body.content ?? "").trim();
          if (!content) return jsonError("Empty learning");
          // This is the endpoint the brain curls when it decides to keep
          // something, so it has to reach whichever memory is live.
          if (deps.adapter) {
            const result = deps.adapter.remember(content, "dashboard");
            if (!result.ok) return jsonError((result.violations ?? ["Could not save that"]).join("; "));
            return Response.json({ ok: true, warnings: result.warnings ?? [] });
          }
          deps.learnings.add(content, "dashboard", deps.clock());
          return Response.json({ ok: true });
        }
        case "/api/learnings/update": {
          const id = Number(body.id);
          const content = String(body.content ?? "").trim();
          if (!Number.isInteger(id)) return jsonError("A learning id is required");
          if (!content) return jsonError("Empty learning");
          deps.learnings.update(id, content);
          return Response.json({ ok: true });
        }
        case "/api/adapter/revert": {
          if (!deps.adapter) return jsonError("No memory adapter is configured");
          const id = Number(body.id);
          if (!Number.isInteger(id)) return jsonError("A revision id is required");
          const result = deps.adapter.revert(id, "dashboard");
          if (!result.ok) return jsonError((result.violations ?? ["Could not revert"]).join("; "));
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
        case "/api/commands/run": {
          if (!deps.runCommand) return jsonError("Command running is not configured", 503);
          const ticket = String(body.ticket ?? "").trim();
          const line = String(body.line ?? "").trim();
          if (!ticket || !line) return jsonError("ticket and line are required");
          try {
            return Response.json({ ok: true, ...(await deps.runCommand({ ticket, line })) });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : String(e), 500);
          }
        }
        case "/api/github-app/comment": {
          if (!deps.githubComment) return jsonError("The GitHub App is not configured", 503);
          const ticket = String(body.ticket ?? "").trim();
          const repo = String(body.repo ?? "").trim();
          const number = Number(body.number);
          const text = typeof body.body === "string" ? body.body : "";
          if (!ticket || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number) || number <= 0 || !text.trim()) {
            return jsonError("ticket, repo (owner/name), number and body are required");
          }
          try {
            return Response.json({ ok: true, ...(await deps.githubComment({ ticket, repo, number, body: text })) });
          } catch (e) {
            return jsonError(e instanceof Error ? e.message : String(e), 500);
          }
        }
        case "/api/restart": {
          // Loopback-only like the rest of this API, and deferred by the
          // handler rather than here: a restart that happens before the
          // response is written is a restart nobody can be told about.
          if (!deps.requestRestart) return jsonError("Self-restart is not configured", 503);
          const reason = String(body.reason ?? "requested over the local API").slice(0, 200);
          deps.requestRestart(reason);
          return Response.json({ ok: true, restarting: true });
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
            return { draft: await deps.draft(thread, channel) };
          });
      }
      return jsonError("Not found", 404);
    }

    return jsonError("Method not allowed", 405);
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/health") {
      const health = deps.slackHealth?.();
      const ui = await deps.uiAccess?.().catch(() => undefined);
      // `ok` means "can do its job", not "the process is up" - a bot that
      // cannot hear Slack is down however well this endpoint answers.
      // `ui` rides along without touching `ok`: being unable to drive the
      // desktop does not stop the bot doing its job, it just needs saying.
      const uiPart = ui ? { ui: describeUiAccess(ui.access), uiState: ui.access, uiCheckedAt: ui.checkedAt } : {};
      // Draining is deliberate, and it is still deaf. The socket can be
      // perfectly healthy while the inbox is not being read at all, and
      // reporting "listening" through that is the same lie the connection
      // watchdog exists to stop - it just arrives from the other side.
      const draining = deps.draining?.() === true;
      const drainPart = draining
        ? { draining: true, slack: "not taking new work - restarting once running turns finish" }
        : {};
      const listening = !draining && (health ? isListening(health.state) : true);
      return Response.json(
        health
          ? {
              ok: listening,
              slack: describeConnection(health, deps.clock()),
              state: health.state,
              since: health.since,
              ...uiPart,
              ...drainPart,
            }
          : { ok: listening, ...uiPart, ...drainPart },
        { status: listening ? 200 : 503 },
      );
    }
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
