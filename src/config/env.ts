/**
 * Environment configuration - parsed and validated once at boot.
 *
 * Fails fast with a readable message if something required is missing, so the bot
 * never limps along half-configured.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseAllowedOwners } from "../domain/githubApp.ts";

/** Where the GitHub App's credentials live by default: outside the repo, never in `.env`. */
export const GITHUB_APP_DIR = join(homedir(), ".config", "jarvis", "github-app");

const boolFromString = (def: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true"));

const schema = z
  .object({
    SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
    SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),
    // Stream replies live via chat.startStream (tool calls shown as a timeline).
    SLACK_STREAM_UPDATES: boolFromString(true),
    // Where Slack traffic comes from. `socket` opens Socket Mode in this
    // process; `inbox` reads what the separate gateway (src/gateway.ts) wrote,
    // so a restart of the bot never drops the connection.
    SLACK_TRANSPORT: z.enum(["socket", "inbox"]).default("socket"),
    // The gateway's queue. Its own file: two processes write it and it must
    // never be committed. Gitignored.
    INBOX_DATABASE_PATH: z.string().default("data/inbox.db"),

    // Bot identity defaults. These only bootstrap a fresh database; once set, the
    // dashboard-managed DB settings take precedence, so the code stays generic.
    BOT_NAME: z.string().default("Assistant"),
    BOT_THINKING_LABEL: z.string().default("working on it..."),
    BOT_THINKING_DONE_LABEL: z.string().default("✅"),

    // Command interfaces. COMMAND_PREFIX is the message trigger (e.g. "//bot" or
    // "X/ev"); SLASH_COMMAND is the Slack slash command registered in the app.
    COMMAND_PREFIX: z.string().default("//bot"),
    SLASH_COMMAND: z.string().default("/bot"),

    // Which brain powers the bot: the local Claude Code CLI (default) or the API.
    LLM_PROVIDER: z.enum(["claude-cli", "anthropic"]).default("claude-cli"),

    // claude-cli provider
    CLAUDE_BIN: z.string().default("claude"),
    CLAUDE_MODEL: z.string().default("opus"),
    // Ordinary chat for the lowest role does not need the expensive model.
    CLAUDE_MODEL_PAL: z.string().default("haiku"),
    CLAUDE_SKIP_PERMISSIONS: boolFromString(true),
    CLAUDE_CWD: z.string().optional(),
    CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    // anthropic provider
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

    OWNER_SLACK_ID: z.string().min(1, "OWNER_SLACK_ID is required"),
    DASHBOARD_PORT: z.coerce.number().int().positive().default(2001),
    // Extra browser origins allowed to POST to the dashboard (comma separated),
    // for when you reach it through a proxy/tunnel/port-forward. Loopback origins
    // are always allowed.
    DASHBOARD_ALLOWED_ORIGINS: z.string().optional(),
    DATABASE_PATH: z.string().default("data/bot.db"),
    // Where the memory adapter is mirrored on disk. The adapter itself lives in
    // the database (`adapter_files`); this directory is re-rendered from it on
    // every write so skills and their scripts can be read by path. Never edit
    // it - use `adapter export` / `adapter import`.
    ADAPTER_PATH: z.string().default("data/adapter-mirror"),
    // Bytes of the adapter that may load into EVERY prompt. A refine pass must
    // come in under it; teaching may exceed it and says so.
    ADAPTER_BUDGET: z.coerce.number().int().positive().default(8000),
    // Commands one chat turn may trigger through the run helper. A runaway
    // guard, not a rate limit: it has to be high enough that ordinary bulk
    // work (deleting a thread's messages, reacting to a batch) finishes, or it
    // becomes pressure to work around the audited path.
    COMMAND_TICKET_USES: z.coerce.number().int().positive().default(50),
    // Per-user Claude Code tokens live in their OWN database, never the one that
    // gets committed, and are encrypted under a key kept beside it. Both paths
    // are gitignored; set them elsewhere if the data directory is shared.
    TOKEN_DATABASE_PATH: z.string().default("data/tokens.db"),
    TOKEN_KEY_PATH: z.string().default("data/tokens.key"),
    // Folder for the activity/error logs (one JSON line per event).
    LOG_DIR: z.string().default("logs"),
    // Channel that gets the one restart notice listing the waiting threads.
    // Unset: nobody is told.
    DRAIN_NOTICE_CHANNEL: z.string().optional(),

    // GitHub App: people call the bot from an issue/PR (mention or label) and
    // the answer is posted back there as the app. Started only when the app id,
    // the private key and the webhook secret can all be found.
    // App id. Unset: read from `app.json` beside the private key.
    GITHUB_APP_ID: z.string().optional(),
    // PEM private key of the app (RS256 JWT -> installation token).
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(join(GITHUB_APP_DIR, "private-key.pem")),
    // Webhook secret. Prefer the file; the variable wins when both are set.
    GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_APP_WEBHOOK_SECRET_PATH: z.string().default(join(GITHUB_APP_DIR, "webhook-secret")),
    // Loopback port of the webhook listener (Tailscale Funnel proxies to it).
    GITHUB_APP_PORT: z.coerce.number().int().positive().default(2003),
    // App slug: `@<slug>` in a comment calls it, `<slug>[bot]` is itself.
    GITHUB_APP_SLUG: z.string().default("jarvis-at-acme"),
    // The app is public, so it only acts for repositories owned by these
    // accounts (comma separated). Everything else is logged and ignored.
    GITHUB_APP_ALLOWED_OWNERS: z.string().default("acme"),
    // Label that calls the app when added to an issue or PR.
    GITHUB_APP_LABEL: z.string().default("jarvis"),
  })
  .refine((env) => env.LLM_PROVIDER !== "anthropic" || !!env.ANTHROPIC_API_KEY, {
    message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
    path: ["ANTHROPIC_API_KEY"],
  });

export type LlmProvider = "claude-cli" | "anthropic";

export type AppConfig = {
  slackBotToken: string;
  slackAppToken: string;
  slackStreamUpdates: boolean;
  slackTransport: "socket" | "inbox";
  inboxDatabasePath: string;
  botName: string;
  botThinkingLabel: string;
  botThinkingDoneLabel: string;
  commandPrefix: string;
  slashCommand: string;
  llmProvider: LlmProvider;
  claudeBin: string;
  claudeModel: string;
  claudeModelPal: string;
  claudeSkipPermissions: boolean;
  claudeCwd?: string;
  claudeTimeoutMs: number;
  anthropicApiKey?: string;
  anthropicModel: string;
  ownerSlackId: string;
  dashboardPort: number;
  dashboardAllowedOrigins: string[];
  databasePath: string;
  /** Mirror directory of the memory adapter, rendered from the database. */
  adapterPath: string;
  /** Bytes of the adapter allowed to load into every prompt. */
  adapterBudget: number;
  /** Commands one turn may trigger through the run helper. */
  commandTicketUses: number;
  tokenDatabasePath: string;
  tokenKeyPath: string;
  logDir: string;
  /** Channel for the restart notice listing waiting threads; unset is silent. */
  drainNoticeChannel?: string;
  githubApp: {
    appId?: string;
    privateKeyPath: string;
    webhookSecret?: string;
    webhookSecretPath: string;
    port: number;
    slug: string;
    allowedOwners: string[];
    label: string;
  };
};

/** A short human label for the active model, shown on the dashboard. */
export const modelLabel = (config: AppConfig): string =>
  config.llmProvider === "claude-cli"
    ? `claude-cli (${config.claudeModel})`
    : config.anthropicModel;

/** Parse `source` (defaults to `process.env`) into a validated config. */
export const loadConfig = (source: Record<string, string | undefined> = process.env): AppConfig => {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  const env = parsed.data;
  return {
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackAppToken: env.SLACK_APP_TOKEN,
    slackStreamUpdates: env.SLACK_STREAM_UPDATES,
    slackTransport: env.SLACK_TRANSPORT,
    inboxDatabasePath: env.INBOX_DATABASE_PATH,
    botName: env.BOT_NAME,
    botThinkingLabel: env.BOT_THINKING_LABEL,
    botThinkingDoneLabel: env.BOT_THINKING_DONE_LABEL,
    commandPrefix: env.COMMAND_PREFIX,
    slashCommand: env.SLASH_COMMAND,
    llmProvider: env.LLM_PROVIDER,
    claudeBin: env.CLAUDE_BIN,
    claudeModel: env.CLAUDE_MODEL,
    claudeModelPal: env.CLAUDE_MODEL_PAL,
    claudeSkipPermissions: env.CLAUDE_SKIP_PERMISSIONS,
    claudeCwd: env.CLAUDE_CWD,
    claudeTimeoutMs: env.CLAUDE_TIMEOUT_MS,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.ANTHROPIC_MODEL,
    ownerSlackId: env.OWNER_SLACK_ID,
    dashboardPort: env.DASHBOARD_PORT,
    dashboardAllowedOrigins: (env.DASHBOARD_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    databasePath: env.DATABASE_PATH,
    adapterPath: env.ADAPTER_PATH,
    adapterBudget: env.ADAPTER_BUDGET,
    commandTicketUses: env.COMMAND_TICKET_USES,
    tokenDatabasePath: env.TOKEN_DATABASE_PATH,
    tokenKeyPath: env.TOKEN_KEY_PATH,
    logDir: env.LOG_DIR,
    ...(env.DRAIN_NOTICE_CHANNEL ? { drainNoticeChannel: env.DRAIN_NOTICE_CHANNEL } : {}),
    githubApp: {
      ...(env.GITHUB_APP_ID?.trim() ? { appId: env.GITHUB_APP_ID.trim() } : {}),
      privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
      ...(env.GITHUB_APP_WEBHOOK_SECRET ? { webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET } : {}),
      webhookSecretPath: env.GITHUB_APP_WEBHOOK_SECRET_PATH,
      port: env.GITHUB_APP_PORT,
      slug: env.GITHUB_APP_SLUG.trim(),
      allowedOwners: parseAllowedOwners(env.GITHUB_APP_ALLOWED_OWNERS),
      label: env.GITHUB_APP_LABEL.trim(),
    },
  };
};
