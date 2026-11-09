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
import type { BotProfile } from "../../application/botProfile.ts";
import type { SlackAdminPort } from "../../application/slackAdmin.ts";
import type { DraftReply } from "../../application/draftReply.ts";
import { createDashboardService, type MemoryAdapterPort, type Outcome } from "../../application/dashboard.ts";
import type { Clock } from "../../application/ports.ts";
import type { CommandLogRepo } from "../db/commandLogRepo.ts";
import type { UsageRepo } from "../db/usageRepo.ts";
import type { MessageRepo } from "../db/messageRepo.ts";
import type { UserRepo } from "../db/userRepo.ts";
import type { LearningsRepo } from "../db/learningsRepo.ts";
import type { KitViewRepo } from "../db/kitViewRepo.ts";
import type { SettingsRepo } from "../db/settingsRepo.ts";
import type { RolePolicyRepo } from "../db/rolePolicyRepo.ts";
import type { StatsRepo } from "../db/statsRepo.ts";
import { createSlackDirectory } from "../../application/slackDirectory.ts";
import { createNameResolver } from "../../application/nameResolver.ts";

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
  /** The RAW allowlist (not the role-enforced view): the deck edits members of a switched-off role too. */
  users: UserRepo;
  /** Per-role policy; the bot enforces from the same rows. */
  rolePolicies?: RolePolicyRepo;
  messages: MessageRepo;
  learnings: LearningsRepo;
  /**
   * The memory adapter, when one is configured.
   *
   * `remember` is what the brain's own save endpoint writes through, so a fact
   * it decides to keep mid-conversation lands in the adapter rather than the
   * old table. `status`, `view` and `files` back the memory page, and `edit`
   * is its hand editor.
   */
  adapter?: MemoryAdapterPort;
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
  /** Activity aggregates for the overview charts. */
  stats?: StatsRepo;
  /** The host's timezone offset in minutes (`Date#getTimezoneOffset`); defaults to the process's. */
  timezoneOffset?: () => number;
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
  /**
   * Act on GitHub as the app (create/edit/close/merge a PR, review, label,
   * request reviewers). Ticketed; the bot requires the admin role of whoever
   * the ticket resolves to. Returns GitHub's JSON.
   */
  githubAction?: (req: { ticket: string } & Record<string, unknown>) => Promise<Record<string, unknown>>;
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
    "img-src 'self' data: https://*.slack-edge.com https://secure.gravatar.com; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
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

  const app = createDashboardService({
    ownerSlackId: config.ownerSlackId,
    clock: deps.clock,
    profile: deps.profile,
    users: deps.users,
    messages: deps.messages,
    learnings: deps.learnings,
    settings: deps.settings,
    adapter: deps.adapter,
    commandLog: deps.commandLog,
    usage: deps.usage,
    kitViews: deps.kitViews,
    stats: deps.stats,
    timezoneOffset: deps.timezoneOffset ?? (() => new Date(deps.clock()).getTimezoneOffset()),
    // One copy of the workspace directory per server, refreshed every ten
    // minutes, so the Users page search is not a `users.list` sweep per key.
    directory: deps.slack?.listMembers
      ? createSlackDirectory({ clock: deps.clock, listMembers: deps.slack.listMembers })
      : undefined,
    resolveNames: deps.slack ? (ids) => deps.slack!.resolveNames([...ids]) : undefined,
    rolePolicies: deps.rolePolicies,
    // One cache for the life of the server, so opening a page never costs a
    // Slack call per row - see `nameResolver.ts`.
    names: createNameResolver({
      clock: deps.clock,
      knownName: (id) => deps.users.get(id)?.displayName || undefined,
      lookups: deps.slack
        ? {
            users: (ids) => deps.slack!.resolveNames([...ids]),
            conversation: async (id) => (deps.slack!.conversationInfo ? deps.slack!.conversationInfo(id) : undefined),
          }
        : undefined,
    }),
  });

  /** A use case's outcome as a response: its value merged into `{ ok: true }`, or its refusal. */
  const reply = <T>(o: Outcome<T>): Response =>
    o.ok ? Response.json({ ok: true, ...(o.value ?? {}) }) : jsonError(o.error, o.status);
  const ok = (): Response => Response.json({ ok: true });

  const api = async (req: Request, url: URL): Promise<Response> => {
    const q = (name: string) => url.searchParams.get(name);
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
          return Response.json(app.overview());
        case "/api/users":
          return Response.json(await app.listUsers());
        case "/api/roles":
          return Response.json(app.roles());
        case "/api/learnings":
          return Response.json(app.learnings());
        case "/api/adapter/files": {
          const files = app.adapterFiles();
          return files.ok ? Response.json(files.value) : jsonError(files.error, files.status);
        }
        case "/api/adapter":
          return Response.json(app.adapterView());
        case "/api/identity":
          return Response.json(app.identity());
        case "/api/commands":
          return Response.json(app.commands());
        case "/api/command-log":
          return Response.json(await app.commandLog());
        case "/api/usage":
          return Response.json(await app.usage(q("hours")));
        case "/api/conversations":
          return Response.json(await app.conversations(q("cursor"), q("limit")));
        case "/api/conversation":
          return Response.json(await app.conversation(q("channel") ?? "", q("before"), q("limit")));
        case "/api/stats":
          return Response.json(await app.stats(q("days")));
        case "/api/slack/members": {
          const found = await app.searchMembers(q("q"));
          return found.ok ? Response.json(found.value) : jsonError(found.error, found.status);
        }
        // --- Slack console (live Slack Web API) ---
        case "/api/slack/conversations":
          return slackGuard(() => deps.slack!.listConversations());
        case "/api/slack/history": {
          const channel = q("channel") ?? "";
          const limit = Math.min(100, Math.max(1, Number(q("limit")) || 30));
          const cursor = q("cursor") || undefined;
          return slackGuard(() => deps.slack!.history(channel, limit, cursor));
        }
        case "/api/slack/thread":
          return slackGuard(() => deps.slack!.replies(q("channel") ?? "", q("ts") ?? ""));
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
        case "/api/users":
          return reply(app.saveUser(body.slackId, body.role, body.displayName));
        case "/api/users/remove":
          return reply(app.removeUser(body.slackId));
        case "/api/users/update":
          return reply(app.updateUser({
            slackId: body.slackId,
            newSlackId: body.newSlackId,
            displayName: body.displayName,
            githubLogins: body.githubLogins,
            role: body.role,
          }));
        case "/api/roles":
          app.setExecuterTools(body.executerTools);
          return ok();
        case "/api/roles/policy":
          return reply(app.saveRolePolicy({
            role: body.role,
            enabled: body.enabled,
            deniedCommands: body.deniedCommands,
            deniedTools: body.deniedTools,
            deniedMcpServers: body.deniedMcpServers,
          }));
        case "/api/roles/assign":
          return reply(app.assignRole(body.slackId, body.role));
        case "/api/kit/views":
          return reply(app.saveKitView(body.view));
        case "/api/learnings":
          return reply(app.teach(body.content));
        case "/api/learnings/update":
          return reply(app.updateLearning(body.id, body.content));
        case "/api/learnings/remove":
          return reply(app.removeLearning(body.id));
        case "/api/adapter/revert":
          return reply(app.revertAdapter(body.id));
        case "/api/adapter/file":
          return reply(app.editAdapterFile(body.path, body.content, body.base));
        case "/api/identity":
          return reply(app.saveIdentity({
            name: body.name,
            thinkingLabel: body.thinkingLabel,
            thinkingDoneLabel: body.thinkingDoneLabel,
            prompt: body.prompt,
          }));
        case "/api/prompt/reset":
          app.resetPrompt();
          return ok();
        case "/api/conversation/clear":
          app.clearConversation(body.channel);
          return ok();
        case "/api/commands/toggle":
          return reply(app.toggleCommand(body.name, body.enabled));
        case "/api/command-log/clear":
          app.clearCommandLog();
          return ok();

        // --- Hooks other processes call: the brain's helpers and the restart script ---
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
        case "/api/github-app/action": {
          if (!deps.githubAction) return jsonError("The GitHub App is not configured", 503);
          const ticket = String(body.ticket ?? "").trim();
          if (!ticket) return jsonError("ticket is required");
          try {
            return Response.json({ ok: true, ...(await deps.githubAction({ ...body, ticket })) });
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
