/**
 * Environment configuration - parsed and validated once at boot.
 *
 * Fails fast with a readable message if something required is missing, so E.V.
 * never limps along half-configured.
 */
import { z } from "zod";

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  OWNER_SLACK_ID: z.string().min(1, "OWNER_SLACK_ID is required"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(2001),
  DASHBOARD_TOKEN: z.string().min(24, "DASHBOARD_TOKEN must be at least 24 characters"),
  DATABASE_PATH: z.string().default("data/ev.db"),
});

export type AppConfig = {
  slackBotToken: string;
  slackAppToken: string;
  anthropicApiKey: string;
  anthropicModel: string;
  ownerSlackId: string;
  dashboardPort: number;
  dashboardToken: string;
  databasePath: string;
};

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
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.ANTHROPIC_MODEL,
    ownerSlackId: env.OWNER_SLACK_ID,
    dashboardPort: env.DASHBOARD_PORT,
    dashboardToken: env.DASHBOARD_TOKEN,
    databasePath: env.DATABASE_PATH,
  };
};
