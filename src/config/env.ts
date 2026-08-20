/**
 * Environment configuration - parsed and validated once at boot.
 *
 * Fails fast with a readable message if something required is missing, so E.V.
 * never limps along half-configured.
 */
import { z } from "zod";

const boolFromString = (def: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true"));

const schema = z
  .object({
    SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
    SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),

    // Which brain powers E.V.: the local Claude Code CLI (default) or the API.
    LLM_PROVIDER: z.enum(["claude-cli", "anthropic"]).default("claude-cli"),

    // claude-cli provider
    CLAUDE_BIN: z.string().default("claude"),
    CLAUDE_MODEL: z.string().default("opus"),
    CLAUDE_SKIP_PERMISSIONS: boolFromString(true),
    CLAUDE_CWD: z.string().optional(),
    CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    // anthropic provider
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),

    OWNER_SLACK_ID: z.string().min(1, "OWNER_SLACK_ID is required"),
    DASHBOARD_PORT: z.coerce.number().int().positive().default(2001),
    DASHBOARD_TOKEN: z.string().min(24, "DASHBOARD_TOKEN must be at least 24 characters"),
    DATABASE_PATH: z.string().default("data/ev.db"),
  })
  .refine((env) => env.LLM_PROVIDER !== "anthropic" || !!env.ANTHROPIC_API_KEY, {
    message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
    path: ["ANTHROPIC_API_KEY"],
  });

export type LlmProvider = "claude-cli" | "anthropic";

export type AppConfig = {
  slackBotToken: string;
  slackAppToken: string;
  llmProvider: LlmProvider;
  claudeBin: string;
  claudeModel: string;
  claudeSkipPermissions: boolean;
  claudeCwd?: string;
  claudeTimeoutMs: number;
  anthropicApiKey?: string;
  anthropicModel: string;
  ownerSlackId: string;
  dashboardPort: number;
  dashboardToken: string;
  databasePath: string;
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
    llmProvider: env.LLM_PROVIDER,
    claudeBin: env.CLAUDE_BIN,
    claudeModel: env.CLAUDE_MODEL,
    claudeSkipPermissions: env.CLAUDE_SKIP_PERMISSIONS,
    claudeCwd: env.CLAUDE_CWD,
    claudeTimeoutMs: env.CLAUDE_TIMEOUT_MS,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.ANTHROPIC_MODEL,
    ownerSlackId: env.OWNER_SLACK_ID,
    dashboardPort: env.DASHBOARD_PORT,
    dashboardToken: env.DASHBOARD_TOKEN,
    databasePath: env.DATABASE_PATH,
  };
};
