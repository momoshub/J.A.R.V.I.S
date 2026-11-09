/**
 * Gateway entrypoint: `bun run src/gateway.ts`.
 *
 * Holds the Slack socket and writes every envelope to the inbox, for the bot
 * (`src/index.ts` with `SLACK_TRANSPORT=inbox`) to read. Run it under its own
 * supervisor, separate from the bot, so restarting the bot never drops Slack.
 *
 * It reads only the two variables it needs, on purpose: validating the bot's
 * whole config here would mean a new required bot setting could stop the
 * gateway from starting.
 */
import { z } from "zod";
import { openInbox } from "./infrastructure/inbox/inboxRepo.ts";
import { startGateway } from "./infrastructure/slack/gateway.ts";
import { ignoreQuietly } from "./application/ignoredError.ts";

const env = z
  .object({
    SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),
    INBOX_DATABASE_PATH: z.string().default("data/inbox.db"),
  })
  .safeParse(process.env);

if (!env.success) {
  console.error(`[gateway] bad config: ${env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  process.exit(1);
}

const inbox = openInbox(env.data.INBOX_DATABASE_PATH);
const gateway = await startGateway({ appToken: env.data.SLACK_APP_TOKEN, inbox }).catch((err: unknown) => {
  console.error("[gateway] failed to start:", err);
  process.exit(1);
});

const shutdown = async () => {
  console.log("[gateway] shutting down");
  await gateway.stop().catch(ignoreQuietly("gateway stop"));
  inbox.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
