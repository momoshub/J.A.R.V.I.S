# E.V.

A Slack bot with the temperament of Tony Stark: brilliant, quick, lightly sarcastic, and actually useful. Named after E.V. from Spider-Man: Brand New Day.

E.V. talks only to an allowlist of Slack users, remembers each channel's conversation in a local SQLite database, and is managed either from Slack (`!` commands) or a web dashboard on port `2001`.

## Stack

- **Bun** + **TypeScript**, functional style (no classes)
- **@slack/bolt** in Socket Mode (no public URL needed)
- **brain**: your local **Claude Code CLI** (default, full tool access) or the **@anthropic-ai/sdk** API
- **bun:sqlite** for memory
- **bun test** for TDD

## Setup

```bash
bun install
cp .env.example .env   # fill in the values
```

Required env (see `.env.example`):

| var | meaning |
| --- | --- |
| `SLACK_BOT_TOKEN` | Bot User OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token with `connections:write` (`xapp-...`) |
| `SLACK_STREAM_UPDATES` | `true` (default) streams replies live; `false` posts once |
| `LLM_PROVIDER` | `claude-cli` (default) or `anthropic` |
| `CLAUDE_BIN` | claude binary, default `claude` (claude-cli) |
| `CLAUDE_MODEL` | model alias/id, default `opus` (claude-cli) |
| `CLAUDE_SKIP_PERMISSIONS` | `true` gives full tool permissions (claude-cli) |
| `CLAUDE_CWD` | working dir the CLI runs in, scopes tool access (claude-cli) |
| `CLAUDE_TIMEOUT_MS` | per-reply timeout, default `120000` (claude-cli) |
| `ANTHROPIC_API_KEY` | required only when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | defaults to `claude-opus-4-8` (anthropic) |
| `OWNER_SLACK_ID` | the owner, cannot be removed (default `U0OWNER0001`) |
| `DASHBOARD_PORT` | dashboard port (default `2001`) |
| `DASHBOARD_TOKEN` | token to reach the dashboard (min 24 chars) |
| `DATABASE_PATH` | sqlite file (default `data/ev.db`) |

### Brain: Claude Code CLI (default)

With `LLM_PROVIDER=claude-cli`, E.V. shells out to your local `claude` binary in
print mode (`claude -p --output-format json`) for every reply, so she answers
with Claude Code's full tool access (files, shell, MCP) under whatever
permissions the CLI runs with. E.V. stays the memory owner: her per-channel
SQLite window is rendered into each stateless invocation, so no CLI session state
is relied upon. Requires `claude` installed and authenticated on the host.

`CLAUDE_SKIP_PERMISSIONS=true` passes `--dangerously-skip-permissions` - full
permissions, matching the original brief. Scope tool access with `CLAUDE_CWD`.

## Run

```bash
bun run db:seed   # optional; boot also seeds the owner
bun start         # or: bun dev  (watch mode)
```

The Slack app needs Socket Mode on, plus the `app_mention` and `message.im` event subscriptions and the `chat:write`, `app_mentions:read`, `im:history`, `users:read` scopes.

## Talking to E.V.

- DM her, or @-mention her in a channel she is in
- She replies in-thread, streaming the answer live as it is generated
- Tool calls (shell, file reads, Slack API, etc.) show as a task timeline while she works
- She only answers allowlisted users; the owner is always allowed
- For questions about the Slack workspace she uses her own bot token and the Slack Web API, never a third-party connector

### Commands (prefix with `!`)

| command | who | effect |
| --- | --- | --- |
| `!help` | anyone | list commands |
| `!whoami` | anyone | show your role |
| `!users` | admins | list the allowlist |
| `!add @user [admin\|member]` | admins (admin role: owner only) | grant access |
| `!remove @user` | admins (admins: owner only) | revoke access |
| `!promote @user` / `!demote @user` | owner | change role |
| `!forget` | anyone | wipe E.V.'s memory of this channel |

## Dashboard

Open `http://localhost:2001/?token=YOUR_DASHBOARD_TOKEN` (loopback only). Tabs:

- **Overview** - counts for users, conversations, stored turns, learnings
- **Users** - add or revoke allowlisted users and roles (the owner is protected)
- **Learnings** - add/delete durable facts that get injected into every reply as known facts
- **Prompt** - edit E.V.'s system prompt (personality and rules) live, or reset to the built-in default
- **Conversations** - browse every channel and DM, read the stored turns, and clear a channel's memory

Prompt overrides and learnings are stored in the DB and applied on the next reply - no restart needed.

## Testing

```bash
bun test          # full suite
bun run typecheck  # tsc --noEmit
```

## Notes

- The runtime database (`data/*.db`) is gitignored on purpose. It holds live conversation content and would churn on every message. The schema and owner seed are code, so the database is fully reproducible.
- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
