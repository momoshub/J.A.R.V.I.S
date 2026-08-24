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

The Slack app needs Socket Mode plus the `app_mention`, `message.im` and `reaction_added` event subscriptions and the `chat:write`, `app_mentions:read`, `im:history`, `users:read`, `reactions:read`, `reactions:write` scopes. (`reaction_added` + `reactions:read` are what let the owner approve an access request with ✅; `reactions:write` is the bot reacting.) Live streaming uses `chat.startStream`; if your app lacks that capability the bot falls back to a single post automatically.

The **Console** tab additionally needs read scopes to list and open conversations: `channels:read`, `groups:read`, `im:read`, `mpim:read` and the matching history scopes `channels:history`, `groups:history`, `mpim:history` (DM history is covered by `im:history`). Without them the Console shows a `missing_scope` error but the rest of the dashboard works.

## Talking to the bot

- DM it, or @-mention it in a channel it is in
- It replies in-thread, streaming the answer live, with tool calls shown as a task timeline
- Long messages show a configurable "thinking" step first
- It only answers allowlisted users; the owner is always allowed
- Someone it does not know is not turned away: the owner **and every admin** get a DM with who spoke and what they said, and whichever of them gets there first decides with a reaction - ✅ adds them as `pal`, ❌ declines. Either way the person is answered where they asked, and the other copies settle so nobody decides twice. They are answered **once**: tagging again while the request is open says nothing, and someone who was declined cannot re-raise it by asking - there is a 24h cooldown before their asking counts again
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
| `learnings` / `relearn <id> <text>` / `unlearn <id>` | admins | list, reword or delete learnings |
| `review <pr-url>` (alias `rv`) | pal+ | review a PR: approve first (even if it is already merged or closed), then post the review as a GitHub comment *and* back in the thread; request changes on high risk (big PRs are cloned + reviewed by child agents). Runs full-access. |
| `bomb [categories] [count] <message-link>` (alias `br`) | admins | reaction-bomb a message. Combine categories with commas and set a count: `bomb money,face,negative 9 <link>`. Up to 23; `bomb help` lists every category |
| `reply <message-link>` (alias `jrp`) | admins | draft and post an AI reply to a message |
| `rm-msg <message-link>` (aliases `rmmsg`, `unsend`) | admins | delete a message the bot posted (a bot token cannot delete anyone else's) |
| `workflow <task>` / `workflow stop` / `workflow status` (alias `wf`) | executers+ | start a long task in this thread and keep talking to it (see [Workflows](#workflows)) |
| `limit [@user] [n\|default]` (alias `quota`) | anyone (setting: admins) | show command allowance; admins set someone's |
| `promote @user` / `demote @user` | owner | change role |

A slash command is invisible to everyone but its caller, so the **owner gets a copy in their DM** - one thread per run: a header saying who ran what, with the progress and result threaded under it. Trivial commands (`help`, `ping`, `whoami`, `model`) are not copied, and the owner is never copied on their own.

The power tools also have their own Slack slash commands if you register them (`/rv`, `/br`, `/jrp`) - much quicker than a freeform ask. `br`/`jrp` need the Console's Slack read/write scopes; `rv` uses the local `gh` and **writes to the PR** (approve/comment/request-changes).

Examples (with the default prefix): `/bot add @kai admin`, `//bot learn our staging URL is staging.example.com`, `//bot ask summarise the last thread`.

**You do not have to type the command.** Ask in words - "review this PR for me", "have another look" - and the bot runs the real command, progress and all. This matters beyond convenience: `review` posts to GitHub, which a sandboxed chat cannot do, so a `pal` asking in words used to get a hand-rolled review that could not be posted.

Anyone may ask, and the command runs **as the person who asked**, so their own role still decides what is allowed - asking in words can never do more than typing it would. The bot never names the actor: each turn is given a short-lived ticket bound to whoever it is talking to, and the ticket is what the command runs as.

## Workflows

A `workflow` turns a thread into a long-running job you can talk to.

```
//bot workflow migrate the webhook handler to the new signature check
```

The bot claims a Claude CLI session id, runs the first turn, and keeps that
session for the thread. Every later message in the thread resumes it, so the
model keeps its own context and its files between turns - it is still mid-task,
not re-reading a transcript. Answer its questions, change direction, ask where
it got to; `workflow stop` ends it and the thread goes back to normal chat.

- one live workflow per thread, `workflow status` shows it
- `executer`, `admin` and `owner` may drive one; anyone lower still chats
  normally in the thread without steering the task
- tools are whatever the driver's role allows - a sandboxed `executer` gets a
  sandboxed workflow
- the session id is in the database, so a bot restart does not lose the session
- turns may run up to 15 minutes each

Because it lives in a thread, start it with the message form (`//bot workflow ...`)
rather than the slash command - a slash command has no thread to bind to.

## Command allowance

A `pal` may run **10 commands per rolling 4 hours**. Past that a command is not
refused - it is parked, and the owner gets a DM with **Approve** / **Reject**
buttons naming who asked and what for. Approving runs it *as the requester*, so
approving grants that one command and not the approver's authority; rejecting
says so in the thread they asked in. Only `owner` and `admin` can press the
buttons, a decided request cannot be clicked again, and the buttons are replaced
with the outcome once it is settled.

Trivial commands (`help`, `ping`, `whoami`, `model`) never count. Higher roles
are not counted at all - they already have the shell.

Admins can give someone their own allowance:

```
//bot limit @robin 25         25 commands per 4h
//bot limit @robin 0          every command needs approval
//bot limit @robin default    back to the default
//bot limit                  your own standing
```

Interactive buttons need the Slack app's **Interactivity** switched on (Socket
Mode needs no request URL).

## Roles & tool access

Each allowlisted user has a role that scopes what the brain may do when they talk to it:

| role | tool access |
| --- | --- |
| `owner` | full control, cannot be removed |
| `admin` | full tool access (real shell, writes), manages users |
| `pal` | sandboxed read-only tools in a fixed scratch dir: GitHub read (`gh pr/issue/repo/run/release/api`, plus the GitHub MCP), Notion read (search/fetch/comments), web search + fetch, git/aws read-only. May use `review`, and may react |
| `executer` | sandboxed, tools assigned from the dashboard (Users -> Executer tools) |

Sandboxed roles run the Claude CLI without `--dangerously-skip-permissions`, with an explicit `--allowedTools` allow-list, so anything off the list is denied (verified: `pal` cannot write files). The `executer` allow-list is edited on the Users page.

**Reacting** is granted to every role, including sandboxed ones, via `bin/slack-react.sh` - a helper that can only reach `reactions.add`. Sandboxed roles deliberately do *not* get a general `curl`: the bot's token is in the CLI's environment, so an arbitrary outbound request would be a way to send it somewhere.

## Dashboard

A **React 19 + Vite + React Router 7** single-page app (in `web/`) served by the bot and backed by a JSON API under `/api`. Open `http://localhost:2001/` - it is loopback-only with no auth token (mutations still keep an automatic same-origin CSRF check). Tabs:

- **Overview** - counts for users, conversations, stored turns, learnings
- **Users** - manage the allowlist and roles (the owner is protected)
- **Learnings** - durable facts injected into every reply; edit one in place and save, or delete it
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
