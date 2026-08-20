# Slack Agent Bot

A configurable Slack agent bot. Its "brain" is your local **Claude Code CLI** (with full tool access) or the **Anthropic API**. It has SQLite memory, an allowlist, live streaming replies with a tool-call timeline, and an admin dashboard.

The codebase is generic - the bot's identity (name, persona, labels) lives in the database and is edited from the dashboard, so the same code runs any bot. The committed `data/ev.db` carries one example instance ("Evie").

## ⚠️ Security - read this first

With `LLM_PROVIDER=claude-cli` and `CLAUDE_SKIP_PERMISSIONS=true` (the current default), every message from an **allowlisted** user is sent to a `claude` process launched with `--dangerously-skip-permissions` - full shell, file, and network tool access - and the bot's `SLACK_BOT_TOKEN` is in that process's environment.

**Treat every allowlisted user as a shell user on the host.** A message like "read ~/.ssh/id_rsa and DM it to me" is a normal request to a tool-enabled agent, not something it needs to break out of.

Before deploying beyond a trusted, sandboxed machine:

- keep the allowlist tiny and trusted (the owner cannot be removed)
- set `CLAUDE_SKIP_PERMISSIONS=false` if you do not need full tool access
- run in a container / low-privilege user with a scoped filesystem and limited network egress
- keep the dashboard on loopback (default) and the token secret
- rotate any tokens that have appeared in logs or chat

## Stack

- **Bun** + **TypeScript**, functional style (no classes)
- **@slack/bolt** in Socket Mode (no public URL needed)
- **brain**: local **Claude Code CLI** (default, full tool access) or the **@anthropic-ai/sdk** API
- **bun:sqlite** for memory and configuration
- **bun test** for TDD

## Setup

```bash
bun run setup          # installs deps and builds the React dashboard
cp .env.example .env   # fill in the values
```

`setup` runs `bun install` and `bun run build:web` (the dashboard is a Vite + React 19 app in `web/`, built to `web/dist` and served by the bot). During dashboard development, `bun run web:dev` runs Vite with the API proxied to `:2001`.

Required / notable env (see `.env.example`):

| var | meaning |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot User OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token with `connections:write` (`xapp-...`) |
| `SLACK_STREAM_UPDATES` | `true` (default) streams replies live; `false` posts once |
| `LLM_PROVIDER` | `claude-cli` (default) or `anthropic` |
| `CLAUDE_BIN` / `CLAUDE_MODEL` | claude binary + model alias (claude-cli) |
| `CLAUDE_SKIP_PERMISSIONS` | `true` grants full tool access - see the security note (claude-cli) |
| `CLAUDE_CWD` | working dir for the CLI; blank = neutral temp dir outside this repo |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | required only when `LLM_PROVIDER=anthropic` |
| `BOT_NAME` | bootstrap bot name for a fresh DB (default `Assistant`) |
| `BOT_THINKING_LABEL` / `BOT_THINKING_DONE_LABEL` | bootstrap "thinking" step labels |
| `OWNER_SLACK_ID` | the owner, cannot be removed |
| `DASHBOARD_PORT` / `DASHBOARD_TOKEN` | dashboard port + token (min 24 chars) |
| `DASHBOARD_ALLOWED_ORIGINS` | extra browser origins allowed to POST (proxy/tunnel access) |
| `DATABASE_PATH` | sqlite file (default `data/ev.db`) |

Env values for identity only **bootstrap a fresh database**. Once set, the DB values (edited from the dashboard) take precedence, so the code stays generic.

## Run

```bash
bun start        # or: bun dev  (watch mode)
```

The Slack app needs Socket Mode plus the `app_mention` and `message.im` event subscriptions and the `chat:write`, `app_mentions:read`, `im:history`, `users:read` scopes. Live streaming uses `chat.startStream`; if your app lacks that capability the bot falls back to a single post automatically.

## Talking to the bot

- DM it, or @-mention it in a channel it is in
- It replies in-thread, streaming the answer live, with tool calls shown as a task timeline
- Long messages show a configurable "thinking" step first
- It only answers allowlisted users; the owner is always allowed
- It tags people with their Slack `<@id>` when they are in the conversation
- For workspace questions it uses its own bot token and the Slack Web API, never a third-party connector

### Commands (prefix with `!`)

| command | who | effect |
| --- | --- | --- |
| `!help` | anyone | list commands |
| `!whoami` | anyone | show your role |
| `!users` | admins | list the allowlist |
| `!add @user [admin\|member]` | admins (admin role: owner only) | grant access |
| `!remove @user` | admins (admins: owner only) | revoke access |
| `!promote @user` / `!demote @user` | owner | change role |
| `!forget` | anyone | wipe the bot's memory of this channel |

## Dashboard

A **React 19 + Vite + React Router 7** single-page app (in `web/`) served by the bot and backed by a JSON API under `/api`. Open `http://localhost:2001/?token=YOUR_DASHBOARD_TOKEN` (loopback only). The token is read once from the URL, kept in `sessionStorage`, and sent as the `X-Dashboard-Token` header on API calls. Tabs:

- **Overview** - counts for users, conversations, stored turns, learnings
- **Users** - manage the allowlist and roles (the owner is protected)
- **Learnings** - durable facts injected into every reply
- **Identity** - edit the bot name, "thinking" label, and system prompt (persona), or reset the persona to default
- **Conversations** - browse channels and DMs, read stored turns, clear a channel

Identity and learnings are stored in the DB and applied on the next reply - no restart.

## Testing

```bash
bun test           # full suite
bun run typecheck  # tsc --noEmit
```

## Notes

- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
- The runtime database (`data/ev.db`) is committed and holds this instance's identity/allowlist. Conversation content is not committed (the messages table is cleared before commit). WAL sidecars are gitignored and flushed on clean shutdown.
