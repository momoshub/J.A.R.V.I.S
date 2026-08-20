# Slack Agent Bot

A configurable Slack agent bot. Its "brain" is your local **Claude Code CLI** (with full tool access) or the **Anthropic API**. It has SQLite memory, an allowlist, live streaming replies with a tool-call timeline, and an admin dashboard.

The codebase is generic - the bot's identity (name, persona, labels) lives in the database and is edited from the dashboard, so the same code runs any bot. The committed `data/ev.db` carries one example instance ("Evie").

## ⚠️ Security - read this first

With `LLM_PROVIDER=claude-cli`, an **`owner` or `admin`** message is sent to a `claude` process launched with `--dangerously-skip-permissions` - full shell, file, and network tool access - and the bot's `SLACK_BOT_TOKEN` is in that process's environment. **Treat every owner/admin as a shell user on the host**: "read ~/.ssh/id_rsa and DM it to me" is a normal request to a tool-enabled agent, not something it needs to break out of.

Lower roles are sandboxed (see [Roles & tool access](#roles--tool-access)): `pal`/`executer` run without permission bypass, with an explicit read-only/assigned tool allow-list, in a fixed scratch dir. The `review` command is an exception - it is a preset task that runs full-access (and writes to the PR) for any role that may run it.

Before deploying beyond a trusted, sandboxed machine:

- keep `owner`/`admin` tiny and trusted (the owner cannot be removed); give everyone else `pal`/`executer`
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
| `COMMAND_PREFIX` | message command trigger (default `//bot`; legacy `!` always works) |
| `SLASH_COMMAND` | Slack slash command to register (default `/bot`) |
| `OWNER_SLACK_ID` | the owner, cannot be removed |
| `DASHBOARD_PORT` | dashboard port (local, loopback-only, no auth) |
| `DASHBOARD_ALLOWED_ORIGINS` | extra browser origins allowed to POST (proxy/tunnel access) |
| `DATABASE_PATH` | sqlite file (default `data/bot.db`) |

Env values for identity only **bootstrap a fresh database**. Once set, the DB values (edited from the dashboard) take precedence, so the code stays generic.

## Run

```bash
bun start        # or: bun dev  (watch mode)
```

The Slack app needs Socket Mode plus the `app_mention` and `message.im` event subscriptions and the `chat:write`, `app_mentions:read`, `im:history`, `users:read` scopes. Live streaming uses `chat.startStream`; if your app lacks that capability the bot falls back to a single post automatically.

The **Console** tab additionally needs read scopes to list and open conversations: `channels:read`, `groups:read`, `im:read`, `mpim:read` and the matching history scopes `channels:history`, `groups:history`, `mpim:history` (DM history is covered by `im:history`). Without them the Console shows a `missing_scope` error but the rest of the dashboard works.

## Talking to the bot

- DM it, or @-mention it in a channel it is in
- It replies in-thread, streaming the answer live, with tool calls shown as a task timeline
- Long messages show a configurable "thinking" step first
- It only answers allowlisted users; the owner is always allowed
- It tags people with their Slack `<@id>` when they are in the conversation
- For workspace questions it uses its own bot token and the Slack Web API, never a third-party connector

### Commands

Every command has two interfaces - use whichever you like. Both triggers are configurable (`SLASH_COMMAND`, `COMMAND_PREFIX`); the defaults are `/bot` and `//bot`:

- **slash**: `<SLASH_COMMAND> <command> <args>` (register that single slash command in the Slack app config; it sub-routes to all commands. Socket Mode needs no request URL)
- **message**: `<COMMAND_PREFIX> <command> <args>` (or the legacy `!<command>`), in a DM or by @-mentioning the bot

| command | who | effect |
| --- | --- | --- |
| `help` | anyone | list the commands you can run |
| `ping` | anyone | check the bot is awake |
| `whoami` | anyone | show your role |
| `model` | anyone | show the brain and current model |
| `ask <question>` | anyone | one-shot question to the brain |
| `forget` | anyone | wipe the bot's memory of this channel |
| `users` | admins | list the allowlist |
| `add @user [pal\|executer\|admin]` | admins (admin role: owner only) | grant access |
| `remove @user` | admins (admins: owner only) | revoke access |
| `learn <fact>` | admins | teach a durable fact |
| `learnings` / `unlearn <id>` | admins | list / delete learnings |
| `review <pr-url>` (alias `rv`) | pal+ | review a PR: approve first, post a comment; request changes on high risk (big PRs are cloned + reviewed by child agents). Runs full-access. |
| `bomb [category] <message-link>` (alias `br`) | admins | reaction-bomb a message with a burst of emoji |
| `reply <message-link>` (alias `jrp`) | admins | draft and post an AI reply to a message |
| `promote @user` / `demote @user` | owner | change role |

The power tools also have their own Slack slash commands if you register them (`/rv`, `/br`, `/jrp`) - much quicker than a freeform ask. `br`/`jrp` need the Console's Slack read/write scopes; `rv` uses the local `gh` and **writes to the PR** (approve/comment/request-changes).

Examples (with the default prefix): `/bot add @kai admin`, `//bot learn our staging URL is staging.example.com`, `//bot ask summarise the last thread`.

## Roles & tool access

Each allowlisted user has a role that scopes what the brain may do when they talk to it:

| role | tool access |
| --- | --- |
| `owner` | full control, cannot be removed |
| `admin` | full tool access (real shell, writes), manages users |
| `pal` | sandboxed read-only tools in a fixed scratch dir (gh/git/aws read-only, datadog/notion read, web search), and may use `review` |
| `executer` | sandboxed, tools assigned from the dashboard (Users -> Executer tools) |

Sandboxed roles run the Claude CLI without `--dangerously-skip-permissions`, with an explicit `--allowedTools` allow-list, so anything off the list is denied (verified: `pal` cannot write files). The `executer` allow-list is edited on the Users page.

## Dashboard

A **React 19 + Vite + React Router 7** single-page app (in `web/`) served by the bot and backed by a JSON API under `/api`. Open `http://localhost:2001/` - it is loopback-only with no auth token (mutations still keep an automatic same-origin CSRF check). Tabs:

- **Overview** - counts for users, conversations, stored turns, learnings
- **Users** - manage the allowlist and roles (the owner is protected)
- **Learnings** - durable facts injected into every reply
- **Identity** - edit the bot name, "thinking" label, and system prompt (persona), or reset the persona to default
- **Conversations** - browse the bot's own stored memory (SQLite), read turns, clear a channel
- **Console** - a live Slack message manager (the web port of a terminal TUI): pick a channel/DM, read messages and threads, edit or delete the bot's own messages, reply, and generate an AI draft to review before posting. Requires extra Slack scopes (below); missing scopes surface as an in-app error.

Identity and learnings are stored in the DB and applied on the next reply - no restart.

## Testing

```bash
bun test           # full suite
bun run typecheck  # tsc --noEmit
```

## Notes

- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
- The runtime database (`data/ev.db`) is committed and holds this instance's identity/allowlist. Conversation content is not committed (the messages table is cleared before commit). WAL sidecars are gitignored and flushed on clean shutdown.
