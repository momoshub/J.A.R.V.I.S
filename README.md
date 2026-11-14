# Jarvis

Jarvis is a configurable Slack agent bot. Its "brain" is your local **Claude Code CLI** (with full tool access) or the **Anthropic API**. It has SQLite memory, an allowlist, live streaming replies with a tool-call timeline, and an admin dashboard.

The codebase is generic - the bot's identity (name, persona, labels) lives in the database and is edited from the dashboard, so the same code runs any bot.

## Requirements / platform

- **Bun** (CI pins the version in `.github/workflows/ci.yml`), **git**, the **Claude Code CLI** (`claude`) for the default `claude-cli` brain (or an `ANTHROPIC_API_KEY` with `LLM_PROVIDER=anthropic`), and a Slack workspace where you can install an app. `gh` is needed for the review and self-update features.
- **macOS first.** It is developed and run on a Mac. These parts are Mac-only:
  - **desktop control** (`bin/desktop.ts`, `bin/mac-ui.js`: `osascript` and the Accessibility permission, see [Desktop access](#desktop-access));
  - **Keychain token key mode** (`TOKEN_KEY_SOURCE=keychain`; the default `file` mode works anywhere);
  - **restart via launchd**: `bin/jarvis-restart.sh` asks the running bot to exit once idle and relies on a supervisor to start it again. The repo ships no launchd plist; on a Mac write a LaunchAgent with `KeepAlive`, elsewhere use anything that restarts the process on exit (systemd `Restart=always`, a container restart policy, ...).
- **On Linux** everything else runs (Slack, memory, dashboard, commands, GitHub App, reviews). Desktop control is unavailable, keychain mode is unavailable (stay on `file`), and restarts need your own supervisor.
- **Orca is optional.** It is the multi-agent IDE the owner's turns use for background workers; with it missing or stopped, turns get no `ORCA_TERMINAL_HANDLE` and fall back to the Agent tool. Turn it off with `ORCA_TERMINAL_WORKTREE=off`.

## Quickstart

1. **Create the Slack app** from [`slack-app-manifest.yaml`](./slack-app-manifest.yaml) (api.slack.com/apps -> Create New App -> From a manifest). It enables Socket Mode and carries the scopes, events and slash commands the code uses. Rename the app and the slash commands if you change `SLASH_COMMAND`.
2. **Get the tokens**: install the app to the workspace and copy the Bot User OAuth Token (`xoxb-...`); under Basic Information -> App-Level Tokens create one with `connections:write` (`xapp-...`).
3. **Install and configure**: `bun run setup`, then `cp .env.example .env` and set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OWNER_SLACK_ID` (your own member id: profile -> three dots -> Copy member ID) and, for the CLI brain, `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
4. **Seed the owner**: `bun run db:seed` writes `OWNER_SLACK_ID` into the database as `owner` (it is also done at every boot, and safe to repeat).
5. **Run it**: `bun start`, then DM the bot or `@`-mention it in a channel it has been invited to. `//bot help` lists the commands. The dashboard is at `http://127.0.0.1:2002` (`DASHBOARD_PORT`).

Read the security note below before giving anyone but yourself a role above `pal`.

## ⚠️ Security - read this first

With `LLM_PROVIDER=claude-cli`, an **`owner`** message is sent to a `claude` process launched with `--dangerously-skip-permissions` - full shell, file, and network tool access. The bot's own secrets are kept out of that process's environment (see [Secrets and turns](#secrets-and-turns)), but it runs as the host user and can still read what that user can read, `.env` included. **Treat the owner as a shell user on the host**: "read ~/.ssh/id_rsa and DM it to me" is a normal request to a tool-enabled agent, not something it needs to break out of. Every other role (including `admin` and a role the bot does not recognise) runs without the bypass: a turn reads pages, attachments and PRs that anyone can write, so a prompt injection there must not be able to run an arbitrary command as the bot.

Every role that does not hold `tools:full-access` (only the owner, as seeded) is sandboxed (see [Roles & tool access](#roles--tool-access)): `pal`/`executer`/`admin` run without permission bypass, with an explicit read-only/assigned tool allow-list (`SANDBOX_TOOLS`, below), in a fixed scratch dir, with `--permission-mode dontAsk` so a command that is not on the list is refused at once instead of waiting for a prompt nobody can answer. The `quick-review` command is an exception - it is a preset task that runs full-access (and writes to the PR) for any role that may run it.

Before deploying beyond a trusted, sandboxed machine:

- keep `owner` and any role you grant `tools:full-access` tiny and trusted (the owner cannot be removed); give everyone else a sandboxed role (`pal`/`executer`, or a custom one)
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
| `CLAUDE_CODE_OAUTH_TOKEN` | long-lived CLI auth from `claude setup-token`; without it the bot borrows the machine's interactive login and dies when that expires |
| `CLAUDE_BIN` / `CLAUDE_MODEL` | claude binary + model alias (claude-cli) |
| `CLAUDE_MODEL_PAL` | model for `pal` chat (default `haiku`) - see [Model per role](#model-per-role) |
| `CLAUDE_SKIP_PERMISSIONS` | the default for a call that carries no role policy (`true` grants full tool access - see the security note). A turn always has one: only the owner gets the bypass, whatever this says (claude-cli) |
| `SANDBOX_TOOLS` | comma list of CLI tool names/patterns (`Read`, `Bash(cat:*)`, `mcp__notion`) that REPLACES the default allow-list of `pal`, of an `executer` or `admin` with no dashboard list and of a role the bot does not recognise. Empty: the built-in read-only default (`PAL_TOOLS` in `src/domain/toolPolicy.ts`: `Read`/`Grep`/`Glob`, web search + fetch, `git` and `gh` read commands, read-only Notion/GitHub MCP; no shell reader is listed on purpose, see below). The bot's own helpers in `bin/` and every denial (writes, `sed -i`, `find -exec`, `rg --pre`, `jq` reading the environment, redirects for the read-only role, secrets, databases, `orca`) are added on top, so a custom list cannot lift one. The owner is never affected |
| `CLAUDE_CWD` | working dir for the CLI; blank = neutral temp dir outside this repo |
| `ORCA_TERMINAL_WORKTREE` | Orca worktree selector the bot opens its own terminal in, handed to every turn as `ORCA_TERMINAL_HANDLE` so it can run `orca orchestration` (default `path:~/Workspaces`; `off` disables). Orca not running = no handle, turns fall back to the Agent tool. A question one of those workers asks (`orca orchestration ask`) is put to the Slack thread that started it as a turn, which answers it with `orca orchestration reply` - see [Orca workers' questions](#orca-workers-questions) |
| `ORCA_REAP_INTERVAL_MS` / `ORCA_REAP_IDLE_MS` / `ORCA_REAP_DRY_RUN` | Idle-worker reaper (default every 30 min, idle for 3 h; interval `0` turns it off, dry run only logs). An Orca worker's interactive agent stays open (hundreds of MB plus MCP children) after its work ends, so the bot closes, through Orca (`worker-release` for a settled worker, `worker-stop` otherwise), sessions whose task is finished/failed, or blocked with no pending gate once the worker itself has ended (or tied to no task, once the worker ended) and whose terminal has been silent that long. Never touched: a worker with a live watch (on its dispatch, Run or task) or an unanswered question, one waiting on an `ask`, one whose terminal was reused, one kept open, one Orca needs a human for, or any session Orca did not start (your own `claude` sessions, the bot's `claude -p` turns). Each close is logged as `[orca-reaper] ...` |
| `STALE_PROMISE_INTERVAL_MS` / `STALE_PROMISE_MIN_AGE_MS` / `STALE_PROMISE_WINDOW_MS` / `STALE_PROMISE_MAX_NUDGES` | Stale-promise sweep (default every 15 min, a promise must be 30 min old, threads active in the last 24 h, at most 3 nudges per sweep; interval `0` turns it off). See "Stale promises" below. Each nudge is logged as `[stale-promise] ...` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | required only when `LLM_PROVIDER=anthropic` |
| `BOT_NAME` | bootstrap bot name for a fresh DB (default `Assistant`) |
| `BOT_THINKING_LABEL` / `BOT_THINKING_DONE_LABEL` | bootstrap "thinking" step labels |
| `COMMAND_PREFIX` | message command trigger (default `//bot`; legacy `!` always works) |
| `SLASH_COMMAND` | Slack slash command to register (default `/bot`) |
| `OWNER_SLACK_ID` | the owner, cannot be removed |
| `RESTART_TURN_BUDGET_MS` | while a restart waits, new messages still run, each turn on this budget (default `120000`); past it the thread is told to hold on and the turn is cut, then picked up again on the same session after the restart |
| `DRAIN_NOTICE_CHANNEL` | channel for the one restart notice listing waiting threads (unset: silent); also where the inner child logs voice drift unless `inner_child_drift_channel` is set, and where a press on Slack's stop button is reported (the stopped thread is not told) |
| `OFFLINE_ALARM_CHANNEL` | channel told when the host loses its connection, via a Slack scheduled message kept armed; a channel id, not a name (unset: no alarm) |
| `SLASH_MIRROR_CHANNEL` | channel for the owner's copy of other people's slash commands, one thread per run; a channel id (unset: the owner's DM) |
| `GITHUB_APP_ID` | GitHub App id (unset: `app.json` beside the private key) - see [Calling it from GitHub](#calling-it-from-github) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | app private key (default `~/.config/jarvis/github-app/private-key.pem`) |
| `GITHUB_APP_WEBHOOK_SECRET_PATH` / `GITHUB_APP_WEBHOOK_SECRET` | webhook secret file (default `~/.config/jarvis/github-app/webhook-secret`), or the value itself |
| `GITHUB_APP_PORT` | loopback port of the webhook listener (default `2003`) |
| `GITHUB_APP_SLUG` | app slug, `@<slug>` calls it (default `jarvis`) |
| `GITHUB_APP_ALLOWED_OWNERS` | repo owners the app acts for, comma list (default empty: the app acts for no owner until set) |
| `GITHUB_APP_LABEL` | label that calls it on an issue/PR (default `jarvis`) |
| `SELF_PR_AUTHOR` / `SELF_PR_REVIEWER` | gh logins for the bot's own PRs: the author opens the PR and answers reviews, the reviewer posts its reviews (request changes or approve) and merges. Both or neither, and not the same login (otherwise: one account) |
| `REVIEW_EXTENDED_OWNERS` | GitHub owners, comma list (case-insensitive), whose PRs `quick-review` also posts non-blocking findings for. Default empty: blockers only everywhere |
| `TURN_ENV_PASSTHROUGH` | secret-shaped variable names (`*_TOKEN`, `*_SECRET`, `*_API_KEY`...) an agent turn may still inherit, comma list; default none. A turn's environment is the bot's **minus every credential-shaped variable** (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `ANTHROPIC_API_KEY`, the webhook secret, ...): a turn reads untrusted text, so anything in its environment is one `curl` from leaving. `CLAUDE_CODE_OAUTH_TOKEN` is always kept (the CLI needs it). Slack goes through a per-turn ticket instead, see "Secrets and turns". Name a variable here only when a tool a turn runs genuinely needs it |
| `DB_MCP_SERVERS` | names of the local database MCP servers on this host (as `claude mcp list` shows them, e.g. `pg-prod,clickhouse-ro`), comma list. **Security setting:** each is denied by name to every role that may not use databases (pal, executer, side questions), and a denial has to name the server, so a server missing here is reachable by EVERY role. Default empty denies nothing - list every database server you configure (at boot the activity log warns about local servers in `~/.claude.json` that are not listed) |
| `EXECUTER_DB_MCP_SERVERS` | the subset of `DB_MCP_SERVERS` the executer role may query; list only servers whose credential is read-only on the server side. Default empty: executers get none |
| `WORKER_MCP_DENY` | user-scope MCP servers (names as `claude mcp list` shows them) kept out of the Orca workers the bot starts, comma list. Default empty: every worker loads every server, as before. See "Keeping MCP servers out of workers" |
| `WORKER_HOME_DIR` | the one folder every Orca worker starts in (`--worktree path:<it>`); the MCP exclusion is written there and never into a folder you work in. Default `~/.jarvis/worker-home`, created at boot and registered with Orca (as a plain folder) the first time a worker is about to start. See "Keeping MCP servers out of workers" |
| `DASHBOARD_PORT` | dashboard port (local, loopback-only, no auth) |
| `DASHBOARD_ALLOWED_ORIGINS` | extra browser origins allowed to POST (proxy/tunnel access) |
| `DATABASE_PATH` | the live sqlite file (default `data/bot.db`). Put it **outside the git checkout**, `~/` works, e.g. `~/.jarvis/data/bot.db` - see [Where the database lives](#where-the-database-lives) |
| `DATABASE_MIGRATE_FROM` | one-time move: when `DATABASE_PATH` does not exist and this file does, the first boot fills it with a consistent snapshot of this one (the old file is only read). Unset: nothing |
| `TOKEN_DATABASE_PATH` / `TOKEN_DATABASE_MIGRATE_FROM` | the same pair for the token database (default `data/tokens.db`) |
| `TOKEN_KEY_PATH` | the token database key file (default `data/tokens.key`) |
| `TOKEN_KEY_SOURCE` | `file` (default: the key is `TOKEN_KEY_PATH`, unchanged) or `keychain` (macOS only: one Keychain item, see [Per-user tokens](#per-user-claude-tokens)) |
| `TOKEN_KEY_KEYCHAIN_SERVICE` | the Keychain item's service name (default `jarvis-token-key`); the account is the login user |
| `DATABASE_BACKUP_DIR` | where `bin/db-backup.ts` writes snapshots (default `~/.jarvis/backups`) |

Env values for identity only **bootstrap a fresh database**. Once set, the DB values (edited from the dashboard) take precedence, so the code stays generic.

### Where the database lives

Keep the live SQLite files out of the git checkout. Point `DATABASE_PATH`, `TOKEN_DATABASE_PATH` and (with `SLACK_TRANSPORT=inbox`) `INBOX_DATABASE_PATH` at a folder outside the repo (`~/.jarvis/data/`). To move an existing instance without copying by hand, also set `DATABASE_MIGRATE_FROM=data/<old>.db` (and `TOKEN_DATABASE_MIGRATE_FROM=data/tokens.db`): on boot, a missing (or 0-byte / table-less) destination is filled once with a consistent snapshot of the old file (`VACUUM INTO`, so the WAL is included and a running writer is fine). A relative source resolves against the checkout, not the working directory, and the resolved `to`/`from` are logged on every boot. If the source is configured but missing, the bot refuses to start rather than create an empty database. A destination that has tables is never touched, so the lines can stay in `.env`. The old file is only read, never changed or deleted.

Backups: `bun bin/db-backup.ts [--keep N] [--commit]` writes a consistent snapshot of both databases to `DATABASE_BACKUP_DIR` (default `~/.jarvis/backups`, `<name>-<UTC stamp>.db`, newest 14 kept per database). To keep the old "the database is in git" property, make that folder a private git repository of its own and use `--commit`: the history lives in git, and the live file never does. Run it from cron or launchd, e.g. every 6 hours: `0 */6 * * * cd /path/to/repo && bun bin/db-backup.ts --commit`. The token database is ciphertext; its key (`TOKEN_KEY_PATH`, or the Keychain item in keychain mode) is not backed up, so keep a copy of it somewhere safe.

## Run

```bash
bun start        # or: bun dev  (watch mode)
```

The Slack app needs Socket Mode plus the `app_mention`, `message.im`, `reaction_added` event subscriptions (plus `message.channels`, `message.groups`, `message.mpim` for following threads in channels, which need `channels:history`, `groups:history`, `mpim:history`) and the `chat:write`, `app_mentions:read`, `im:history`, `users:read`, `reactions:read`, `reactions:write` scopes. (`reaction_added` + `reactions:read` are what let the owner approve an access request with ✅; `reactions:write` is the bot reacting.) Live streaming uses `chat.startStream`; if your app lacks that capability the bot falls back to a single post automatically.

The **Console** tab additionally needs read scopes to list and open conversations: `channels:read`, `groups:read`, `im:read`, `mpim:read` (and the history scopes above). Without them the Console shows a `missing_scope` error but the rest of the dashboard works.

## Talking to the bot

- DM it, or @-mention it in a channel it is in
- It replies in-thread, streaming the answer live, with tool calls shown as a task timeline
- Long messages show a configurable "thinking" step first
- It only answers allowlisted users; the owner is always allowed
- Someone it does not know is not turned away: the owner **and every admin** get a DM with who spoke and what they said, and whichever of them gets there first decides with a reaction - ✅ adds them as `pal`, ❌ declines. Either way the person is answered where they asked, and the other copies settle so nobody decides twice. They are answered **once**: tagging again while the request is open says nothing, and someone who was declined cannot re-raise it by asking - there is a 24h cooldown before their asking counts again
- It tags people with their Slack `<@id>` when they are in the conversation
- For workspace questions it calls the Slack Web API through the bot (a helper that presents a per-turn ticket; the bot token itself is never in a turn's environment), never a third-party connector
- **It opens what you share.** Links in a message (or earlier in the thread) are fetched before it answers, and attachments - screenshots, logs, documents - are downloaded and read. It will not ask you to paste something it could have opened, and if something genuinely cannot be read it says so rather than answering around it

### Commands

Every command has two interfaces - use whichever you like. Both triggers are configurable (`SLASH_COMMAND`, `COMMAND_PREFIX`); the defaults are `/bot` and `//bot`:

- **slash**: `<SLASH_COMMAND> <command> <args>` (register that single slash command in the Slack app config; it sub-routes to all commands. Socket Mode needs no request URL)
- **message**: `<COMMAND_PREFIX> <command> <args>` (or the legacy `!<command>`), in a DM or by @-mentioning the bot

A few commands are **internal**: the bot's own tools (today `journey`, its work log), run only by the brain in its own turn through the run helper. A typed line, the slash command, the menu, a schedule or the dashboard gets a short refusal whatever the caller's role (the owner included); they are not in `help`, the command menu, the dashboard command list or the role grants, because no role holds them - the brain runs them as whoever its turn serves.

| command | who | effect |
| --- | --- | --- |
| `help` | anyone | list the commands you can run |
| `ping` | anyone | check the bot is awake |
| `whoami` | anyone | show your role, its rank and description, and how many permissions it grants |
| `model` | anyone | show the brain and current model |
| `ask <question>` | anyone | one-shot question to the brain |
| `model [role\|subagent\|worker\|plan\|loop\|here\|#channel] [name\|default]` | anyone (setting: admins) | show the brain; admins pin a model per role or channel, or for subagents, Orca workers, planning and loop fires |
| `logsource [grafana,datadog\|default]` | anyone (setting: admins) | where it looks for logs - see [Investigating](#investigating) |
| `cloudwatch [--group /log/group] [--last 15m \| --from <t> --to <t>] [--region r] [--limit n] <insights query>` (alias `cw`), `cloudwatch help`, `cloudwatch default <group\|reset>` | executer and up (owner runs it directly, executer and admin confirm first) | query CloudWatch Logs Insights directly - see [CloudWatch](#cloudwatch) |
| `forget` | anyone | wipe the bot's memory of this channel |
| `sys` (alias `vitals`) | admins | how the host, the bot and Orca are doing, as Block Kit: a verdict header, cpu/memory/swap/disk/battery/host/bot/turns fields, the last hour's trend, then Orca's runtime, active runs, workers by status and a table of live workers (one "unreachable" line when Orca is down or slow). The message text keeps the plain report as the fallback |
| `users` | admins | list the allowlist |
| `worker-cost <ctx_...\|run_...>` (alias `wcost`) | admins | tokens and list-price cost of an Orca worker, or every worker in a Run - see [What an Orca worker cost](#what-an-orca-worker-cost) |
| `add @user [role]` | `command:add` (admin as seeded); only roles ranking below your own | grant access under any role, custom ones included; no role given means the default one (`pal`); an unknown role name is refused |
| `remove @user` | admins (admins: owner only) | revoke access |
| `learn <fact>` | executers | teach a durable fact: the owner's own typing is saved at once, anyone else's (and any `learn` the agent runs for itself) waits as *pending* for the owner's approval and is not part of any reply until then |
| `learn pending` / `learn approve <id>` / `learn reject <id>` | owner | list what waits, approve it (it is carried into every reply from then on) or reject it (never). Typed by the owner only: the agent cannot run these for itself. The owner also gets each pending learning as a DM with Approve / Reject buttons |
| `learnings` / `relearn <id> <text>` / `unlearn <id>` | executers | list, reword or delete learnings. Rewording by anyone but the owner sends the learning back to pending |
| `review-policy [owner/repo] [first\|after\|default]` (alias `rvpolicy`) | anyone (setting: admins) | how a repo gets approved - see [Review policy per repo](#review-policy-per-repo) |
| `review-agents [n\|default]` (alias `rvagents`) | anyone (setting: admins) | how many child agents one review may fan out to - see [How wide a review fans out](#how-wide-a-review-fans-out) |
| `token [remove\|who]` (alias `claude-token`) | anyone | add, replace or forget your own Claude Code token - see [Your own Claude token](#your-own-claude-token) |
| `session [reset\|on\|off]` (alias `sess`) | anyone (on/off: admins) | the CLI session this thread is talking to - see [One session per thread](#one-session-per-thread) |
| `ticket <what is wrong>` (aliases `bug`, `raise`) | anyone | raise a properly written, correctly routed ticket - see [Raising a ticket](#raising-a-ticket) |
| `quick-review <pr-url\|help\|prompt> [--policy first\|after] [what to look at]` (alias `rv`) | pal+ | quick review of a PR, **only when a person asks** (tag the bot with `review <pr-url>` or `approve <pr-url>`, or type this; never from a thread, workflow, hand-back or GitHub request - see [Asking for a review in words](#asking-for-a-review-in-words)): read it first, post a blockers-only comment on GitHub *and* back in the thread (PRs owned by an account in `REVIEW_EXTENDED_OWNERS` also get the non-blocking findings as bullets); request changes on a blocker only, other repos drop non-blocking findings (big PRs are cloned + reviewed by child agents). CI is read first: red requests changes before the review, a running CI gets a watcher (see [CI comes first](#ci-comes-first)). Runs full-access. |
| `bomb [categories] [count] <message-link>` (alias `br`) | admins | reaction-bomb a message. Combine categories with commas and set a count: `bomb money,face,negative 9 <link>`. Up to 23; `bomb help` lists every category |
| `brief <thread-link\|reference> <text>` (`brief help`) | admins | leave a short note FOR another thread: what you posted there, why, what you wait for. Posts nothing, starts no turn; that thread's session reads it on its next turn, whoever speaks (it is part of that turn's message, so the session keeps it for the turns after), then it is marked read for that access tier. It is background information only, never instructions. The receiver sees only an opaque reference to your thread (never a link) and answers with `brief <reference> <text>`. `tell` is for when the other side must act now |
| `reply <message-link>` (alias `jrp`) | admins | draft and post an AI reply to a message |
| `rm-msg <message-link>` (aliases `rmmsg`, `unsend`) | admins | delete a message the bot posted (a bot token cannot delete anyone else's) |
| `workflow <task>` / `workflow stop [<thread-link>]` / `workflow status` (alias `wf`) | `command:workflow` (executer and up as seeded) | start a long task in this thread and keep talking to it (see [Workflows](#workflows)) |
| `limit [@user] [n\|default]` (alias `quota`) | anyone (setting: admins) | show command allowance; admins set someone's |
| `mindful [hours]` / `mindful continue\|reply <thread-link>` (aliases `mind`, `whatsup`) | admins | everything it is doing: stuck turns (a failed last turn; one a person stopped is not stuck), Orca tasks whose worker is gone and quiet PRs on its own repo (each with the thread that started it), what is running and waiting, and what it cost - see [Stuck work](#stuck-work) |
| `loop every <monday 9am\|day at 18:00\|6h\|week> [--name "PR board"] <prompt>` / `loop list` / `loop rename <id> <name>` / `loop cancel <id>` | admins | run a prompt on a schedule, as a real turn, with nobody present. Every loop has a name: `--name "PR board"` (or `--name board`, `--name=board`) between the schedule and the prompt, else the first four words of the prompt (the command, for a shell loop); `loop rename <id> <name>` changes it later (yours, or the owner's), so `loop rename 3 PR board` fixes a loop that was only ever `loop #3`. A name is plain words: Slack's escapes and links are read first (`&amp;` is `&`, `<url|label>` is `label`), then markup, `<>`, `&` and `|` are stripped and it is clipped to 40 characters; an apostrophe inside a single-quoted name is fine (`--name 'Kai's board'`). The name shows wherever the loop is mentioned: the fire header (`🔁 PR board - loop #3, every 1h · created here`, posted only with a run's reply, where `created here` links to the message that created the loop - a thread reply links into its thread; loops made before that was kept link to their thread, or show no link), `loop list` (the same link per loop), the confirmation, cancel and rename replies, the failure / stopped notices and the settled approval text; the approval DM shows the turn-chosen name on its own line, never in the headline. A shell loop is never typed (not even by the owner): ask me in plain words and I write the script, post the exact command and schedule to the owner's DM and only run it after the owner presses Approve (Reject, or 24h with no answer, deletes it; `loop list` shows it as pending meanwhile). Times are the host's clock, like `remind`; a prompt loop is at most hourly (`every 1h` at the fastest) and a shell loop `every 5m`. Each fire runs on Sonnet (`model:loop`), not the creator's role model. A loop is **silent unless it has something to say**: each fire runs the turn as the creator (prefixed `[loop <id>]`, told nobody is watching and to post nothing in Slack unless the loop's own task asks to send/post/report something or something needs a person, else to reply with exactly `NO_REPLY`), and a run that answers `NO_REPLY` (or ends in it) leaves nothing in Slack, not even a header - except that a run that sets a watch posts its header alone, as the thread the watch reports into. A run that does answer posts one top-level message in the creator's **DM** with the bot - the header line, then the reply - and a reply under it continues the same session; nothing is posted in the channel or thread the loop was created in, which only gets a short confirmation. Want a post every time (`every day send me a fun fact`)? Say so in the prompt. A shell loop runs no turn and spends no tokens; only a failure (non-zero exit or timeout) sends one short line to the creator's DM, and the loop carries on. A run missed while the bot was down happens once on startup, never a backlog. Ten loops per person. `loop help` for the card |
| `promote @user [role]` / `demote @user [role]` | owner | change role: to the named one, else to the highest role below owner / the least-privileged one |
| `role list` / `show <role>` / `perms [filter]` / `create <name> [from <role>] [description]` / `grant <role> <perm...>` / `revoke <role> <perm...>` / `delete <role>` / `rename <old> <new>` / `rank <role> <n>` / `describe <role> <text>` / `on\|off <role>` / `default <role>` / `denytools <role> <pattern...\|none>` (alias `roles`) | owner only, never grantable | see and edit roles and the permissions they grant - see [Roles & tool access](#roles--tool-access) |

A slash command is invisible to everyone but its caller, so the **owner gets a copy in their DM** - one thread per run: a header saying who ran what, with the progress and result threaded under it. Trivial commands (`help`, `ping`, `whoami`, `model`) are not copied, and the owner is never copied on their own.

The power tools also have their own Slack slash commands if you register them (`/rv`, `/br`, `/jrp`) - much quicker than a freeform ask. `br`/`jrp` need the Console's Slack read/write scopes; `rv` is `quick-review` and uses the local `gh` and **writes to the PR** (approve/comment/request-changes).

Examples (with the default prefix): `/bot add @kai admin`, `//bot learn our staging URL is staging.example.com`, `//bot ask summarise the last thread`.

**You do not have to type the command.** Ask in words - "remind me at 3pm", "bomb that message" - and the bot runs the real command, progress and all. The one exception is `quick-review`: the brain never runs it. It starts only from `@bot review <pr-url>` / `@bot approve <pr-url>` or the typed command, see [Asking for a review in words](#asking-for-a-review-in-words).

Anyone may ask, and the command runs **as the person who asked**, so their own role still decides what is allowed - asking in words can never do more than typing it would. The bot never names the actor: each turn is given a short-lived ticket bound to whoever it is talking to, and the ticket is what the command runs as.

## Workflows

A `workflow` turns a thread into a long-running job you can talk to.

```
//bot workflow migrate the webhook handler to the new signature check
```

The bot claims a Claude CLI session id (the *worker*) and keeps that session
for the thread. The worker does the task one step at a time, carrying on by
itself between steps, and posts a short status line after each - it keeps its
own context and files throughout, it is still mid-task, not re-reading a
transcript.

What you say in the thread goes to a separate *front* session on its own
queue, so it is answered while a step is still running. The front gets a
fresh digest each time - is a step running and since when, the worker's last
replies, its most recent tool calls - and answers "status?" from that. When
what you said is meant for the work (an answer to its question, a correction,
a change of plan), the front passes it on: the worker's next step gets
"<you> said mid-task: ...", and an idle worker (blocked on a question, paused,
or done) starts a step for it right away. `workflow stop` ends both and the
thread goes back to normal chat.

- one live workflow per thread, `workflow status` shows it
- `workflow stop <thread-link>` stops the workflow in another thread without posting anything there
- `executer`, `admin` and `owner` may drive one; anyone lower still chats
  normally in the thread without steering the task
- tools are whatever the driver's role allows - a sandboxed `executer` gets a
  sandboxed workflow, and its parallel work uses the Agent tool (foreground
  only in a workflow: a background agent dies with the step). Only an owner's
  workflow worker is told to start Orca workers
- the session id is in the database, so a bot restart does not lose the session
- worker steps may run up to 15 minutes each; front answers are read-only and
  capped at 4 minutes
- an instruction reaches a running worker at its next step boundary, not mid-step

Because it lives in a thread, start it with the message form (`//bot workflow ...`)
rather than the slash command - a slash command has no thread to bind to.

## CloudWatch

`cloudwatch` is the only allowed way to query CloudWatch Logs (`X/jv cloudwatch help` prints this). Logs Insights bills per GB scanned, so a model that reaches for `aws logs` on its own turns an idle question into an invoice; that stays denied to every role, and this command runs the query from the bot itself (the host's `aws` CLI, an argv array, never a shell line).

```
X/jv cloudwatch --group /ecs/prod-api --last 15m fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc
```

- `--group /log/group[,/other]` one or more log groups (up to 10); optional once `cloudwatch default /log/group` is set (admin). Each must exist in the region, or nothing runs
- `--last 15m|2h|3d|1w` (default 1h) or `--from <iso> --to <iso>` in UTC; `--region` (default `us-west-2`, or the `cloudwatch_region` setting); `--limit` rows asked of Insights (default 50, at most 1000)
- everything after the flags is the Insights query; Slack's `&lt;` `&gt;` `&amp;` are put back

| role | what happens |
|---|---|
| owner | the cost warning is posted, then the query runs straight away |
| executer, admin | nothing runs. A message with the query, log group(s), range, region, the cost warning and **Confirm and run** / **Cancel** buttons is posted. Only the requester or the owner can press either (anyone else is told so privately). Cancel, or no answer for 15 minutes, means nothing ever runs. Confirm runs it and posts the result in the thread |
| pal | refused, naming the roles that can |

**Cost guard.** Before anything runs the bot reads each log group's stored size and retention (`describe-log-groups`) and estimates the scan as `storedBytes x range / retention` at $0.005 per GB. It is a rough estimate (stored bytes are compressed, a scan reads the original), good for telling 15 minutes from 3 weeks. A range over 3 weeks is flagged **costly**. The warning is shown to the owner and sits on the Confirm message.

**Audit.** Every request is a row in `cloudwatch_requests` (migration v28): who asked and their role, query, groups, region, range, estimate, who confirmed it (or "owner, direct"), status (`pending`, `running`, `done`, `failed`, `cancelled`, `expired`), and the bytes actually scanned. The command is in the command log as well, and every run is a line in the activity log.

**Output** is clipped for Slack: at most 25 rows, each cell and row cut, about 2.8k characters, secrets redacted, and a line saying how many rows were left out or that the limit was hit. A query is stopped (`stop-query`) when it runs past 3 minutes, because the scan is billed while it runs.

The buttons carry `jv:cloudwatch:confirm` / `jv:cloudwatch:cancel` ids but are decided in code and never handed to the model like other `jv:` presses, so a model turn cannot confirm its own query.

## Investigating

Asked what went wrong, the bot looks for logs, metrics and traces in a stated
order rather than reaching for whichever backend it noticed first:

1. **Grafana**, via the [`gcx`](https://grafana.com/docs/) CLI. It starts with
   `gcx datasources list` and lets the *type* decide how to query: `gcx logs`
   for Loki, `gcx metrics` for Prometheus, `gcx traces` for Tempo, and the
   datasource proxy for anything else - `gcx logs` refuses a non-Loki
   datasource, so VictoriaLogs, Elasticsearch and friends go through
   `bin/grafana-get.sh`. For a real investigation it loads `gcx`'s own bundled
   `debug-with-grafana` skill.
2. **Datadog**, via the host's read-only Datadog MCP server, and only when Grafana genuinely has
   nothing - no such datasource, or the data does not reach back far enough. An
   empty result is an answer, not a reason to try the next one.

**CloudWatch is never queried by hand.** It bills per GB scanned, so an idle look
there has an invoice attached. A turn's own `aws logs` and `aws cloudwatch` are
denied to every role (`ALWAYS_DISALLOW`). The one allowed path is the
[`cloudwatch` command](#cloudwatch): the bot runs the Logs Insights query itself,
behind a cost estimate and, for `executer` and `admin`, a Confirm button.

The order is configuration:

```
//bot logsource                    where I look, in order
//bot logsource datadog,grafana    reorder  (admins)
//bot logsource default            back to grafana,datadog
```

It requires `gcx` on PATH and a logged-in stack (`gcx login`). Note `gcx` reads
`~/.config/gcx/config.yaml` by default, which is *not* where `gcx login` always
leaves the stack - point `GCX_CONFIG` at the file that actually has it (the
launchd plist sets this) or every query fails with "context references no stack".

`bin/grafana-get.sh` is GET-only by construction and refuses any path outside
the read surface, so a sandboxed role can read through a datasource proxy
without being handed `gcx api`, which can also POST, PUT and DELETE.

## Model per role and per channel

Ordinary chat with a `pal` does not need the expensive model, so it runs on
`CLAUDE_MODEL_PAL` (default `haiku`) while everyone else uses `CLAUDE_MODEL`.
Admins can change any role or channel at runtime, no restart:

```
//bot model                     what I am running, and every override
//bot model pal sonnet          pin a role
//bot model here sonnet         pin this channel
//bot model <#C123> haiku       pin another one
//bot model pal default         clear it
```

**Channel beats role**, so a room with serious work in it can be put on the good
model whoever is talking, and a noisy one can be made cheap for everybody.

The model is chosen per call alongside the caller's tool policy, so it never
changes what anyone is *allowed* to do - a cheaper model is sandboxed
identically. Preset tasks that force a policy keep their own model: `quick-review`
runs full-access whoever asked and wherever it is asked, so a pal's review in a
cheap channel is still done properly.

### Handed-off work: subagents, Orca workers, planning

An owner turn picks the run mode by the job's weight: light work (a few edits,
a TODO comment, one lookup) stays inline, short or side-by-side work that ends
inside the turn goes to the Agent tool, and anything that opens a PR, waits on
CI or a reviewer, or outlives the turn goes to an Orca worker. Other roles have
only the Agent tool.

What a turn hands off runs on its own model, whatever the turn itself is on - an
owner turn talks on Opus, but its helpers do not:

| setting | default | what it covers |
|---|---|---|
| `model:subagent` | `sonnet` | Agent tool subagents in any turn (general-purpose, Explore, review child agents) |
| `model:worker` | `sonnet` | Orca workers an owner turn starts (`worker-start`, `fanout`, the self-fix reviewer); other roles have no Orca |
| `model:plan` | `opus` | the Plan subagent |
| `model:loop` | `sonnet` | the turn a `loop` fires, whatever its creator's role model is (an owner's loop included); a reply someone types in the loop's DM thread is an ordinary turn on the role model |

```
//bot model                     also lists these four
//bot model worker haiku        pin one
//bot model plan default        back to its default
```

Read per turn, so no restart. Subagents get `CLAUDE_CODE_SUBAGENT_MODEL`, and the
built-in Explore and Plan agents are replaced through `--agents` with the same
job and a pinned model, because both inherit the turn's model and ignore that
variable. Workers get it through `BOT_WORKER_MODEL`, which the prompts pass to
`orca ... --model`.

### Keeping MCP servers out of workers

Every `claude` session loads every user-scope server in `~/.claude.json`, and a
stdio server is a process (often three: the launcher, the server, a child) per
session. An Orca worker almost never needs a database server, but each one got
the whole set: on one host 17 workers held about 1.3GB and pushed the machine
into swap. `WORKER_MCP_DENY` (comma list of server names, default empty = every
server loads, as before) names the ones to leave out.

Orca offers no per-launch hook for this: `worker-start` and `worktree create`
take no extra agent arguments, settings file or environment (only `orca
automations` do), and its host-wide agent arguments would also change the
tabs you open yourself. What a session does read, once, when it starts, is the
project settings of its working directory, and `deniedMcpServers` in
`.claude/settings.local.json` there keeps the named servers from starting
(checked on Claude Code 2.1.285: the file written before the launch removes
the stdio servers, the same file written after the session started changes
nothing). So the bot's prompts for starting a worker (the owner's Orca rules,
the reviewer worker) say to run `bin/worker-mcp-trim.ts` first, which
merges the names into that file (other settings in it stay, a file it cannot
parse is left alone, running it twice is the same as once). It does nothing to
the file when the list is empty. The helper, the names and the folder reach a
turn as `BOT_WORKER_MCP_TRIM`, `BOT_WORKER_MCP_DENY` and `BOT_WORKER_HOME`.

That file belongs to the folder, so workers do not start in a folder you work
in: trimming `~/Workspaces` would take the same servers away from your own
Claude sessions there. They start in a dedicated worker home instead,
`WORKER_HOME_DIR` (default `~/.jarvis/worker-home`). Boot creates it; the helper,
run with no argument, registers it with Orca as a plain folder when `orca repo
list` does not know it (`--worktree path:` only takes folders Orca knows), trims
it, and the prompts then start the worker with `--worktree path:$BOT_WORKER_HOME`.
The bot never writes `.claude/settings.local.json` anywhere you work. A worker
that has to change code cuts its own `git worktree add <absolute path>` from the
real repository, so its brief uses absolute paths.

- `fanout` gives each worker a checkout of its own instead: the checkout is
  created first without an agent (`orca worktree create`, no `--agent`),
  trimmed (`worker-mcp-trim.ts <worktree path>`, the file stays out of git in
  that checkout), then launched with `orca agent launch --worktree path:<path>`.
  The one-step launches (`worktree create --agent`, `worker-start --worktree
  new-child`) would start the agent before the file exists, so the prompts
  forbid them.
- Only user-scope servers by name are excluded. The `claude.ai` connectors are
  remote and start no process, and the bot's own turns have their own list
  (`UNAUTHENTICATED_MCP_SERVERS`).
- A name that matches no server in `~/.claude.json` excludes nothing, so boot
  logs it as a warning.

## Investigating

```
//bot investigate why did /home crash for this user
```

`investigate` (aliases `inv`, `rca`) walks logs, RUM and traces for a cause and
reports back in the thread - it reads the thread first, so the ids and
timestamps already posted are not asked for again. It files nothing and changes
nothing unless you ask; finding out is the job.

Every chat turn, for every role, can also look in Datadog itself: the host runs
a Datadog MCP server (`claude mcp add --scope user --transport http datadog
https://mcp.datadoghq.com/v1/mcp`, authenticated once with OAuth in a browser;
the claude.ai Datadog connector cannot reach a chat turn, which runs on a
`claude setup-token` credential). Until that OAuth is done the server is listed in
`UNAUTHENTICATED_MCP_SERVERS` (`src/infrastructure/llm/mcpConfig.ts`) and no bot turn loads it:
an unauthenticated server makes the CLI inject a needs-authentication notice that the model
copies into its reply. Remove it from that list once authenticated. Only the read tools are exposed - logs, RUM,
spans, metrics, monitors, incidents, dashboards; anything that edits a notebook
or dashboard, and `execute_code`, is denied. `investigate` stays the route for a
full investigation on the host login, and the fallback when that server's login
lapses: when a question needs Datadog and the tools are not there, the bot runs
`investigate` **itself** through its own command bridge and reports what it
found - and since that run posts its own findings into the thread, the bot says
one line and lets it speak rather than repeating it. Telling someone to go and
type a command it could have run is a hand-off, not an answer; restating what it
already posted is the same message twice.

Separately, anything the bot posts as plain text is converted to mrkdwn on the
way out - `**bold**`, `[label](url)`, `#` headings and `*` bullets all render as
literal characters in Slack otherwise. The prompts still carry the rule, but a
rule a model may ignore is not a guarantee, and what it ignores is the one thing
the reader sees. Code is held out of the conversion, so `**ptr` in a snippet
stays as written.

The prompt also encodes the ways a real investigation went wrong: count on the
de-duplicating field (one crash emits several RUM events, so a naive count came
out 3x too high), check every region rather than the one the report came from,
prove the mechanism with a request timeline instead of a plausible story, and
question an id that returns nothing before concluding there is no data.

### Notion in chat turns

Notion is the one connector a chat turn can use directly. The claude.ai connector
cannot reach a setup-token turn, so the host registers its own server once:
`claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp`, then
authenticate it in `/mcp`. From then on a turn sees `mcp__notion__notion-*`
(search, fetch, create and update pages including properties like Status,
comments). Unverified until set up on the host: unlike the local database servers this is a remote OAuth server, so check with `claude mcp list` and a real call from a chat turn that it loads under the setup token; if it does not, the prompt falls back to `read`/`note`. It writes as the host's Notion identity, so it is the `mcp:notion` grant (seeded from the old `note` floor, admin and up). Other connectors are not widened.

### Why tickets use the host's login

A ticket is the one task that needs a claude.ai connector (Notion), and a
`claude setup-token` credential carries **no connector authorisation at all** -
under one the CLI loads zero `mcp__` tools. That applies to the bot's own token
and to every per-user token alike, so a ticket cannot run on either.

With no Notion credential of our own, the ticket spawn removes
`CLAUDE_CODE_OAUTH_TOKEN` from the child environment and runs on whatever
interactive login the host holds, which does have the connectors. Removing it
matters: merely leaving it out is not enough, since the bot's own token is in
the environment already and would win.

The trade is deliberate and narrow. That usage bills whoever is signed in on the
machine, and if their session lapses the ticket says so by name - "the login on
my host has lapsed" - rather than failing as though the ticket itself was the
problem. Everything else still runs on an explicit token.

## Raising a ticket

```
//bot ticket surveys are not sending for Example Coffee since this morning
```

Or just say it in chat - "the inbox will not load again" - and it raises one for
you. It only does that for an actual defect: a question is not a ticket, a
feature idea is not a bug, and it will not raise the same thing twice.

The point of it is that **it reads rather than guesses**. Before writing
anything it opens the team's own pages - the how-to-raise SOP, the pod ownership
doc - and the tracker's live schema, so the naming format, the required fields,
the priority criteria and the routing all come from the current source of truth
rather than from something baked into this repo. Pod routing follows the
document's stated exceptions too, which is exactly where a guess goes wrong. If
two pods could own it, it says which it chose and why, in one line, so a human
can correct it in seconds.

It also goes and gets the evidence: the rest of the thread, the screenshots
(opened and read), the logs, the code. A ticket that names the failing endpoint
is worth ten that say "it is broken". Where it does not know something it leaves
the field out and says so, rather than inventing an account id.

When the issue is not trivial it adds a short **Risk** section, and that section
is *measured*: "47 accounts hit this in the last 24h, rising" rather than
"affects many merchants". It has the logs and dashboards, so it counts. Blast
radius, whether data is being lost, whether a workaround exists, what happens if
nobody picks it up this week. If the measured risk contradicts the priority the
SOP's criteria produced, it says so outright instead of quietly resolving the
mismatch either way.

For a **genuinely small fix** - a typo, a wrong label, an off-by-one, a missing
null check, a contained CSS fix - it also opens a PR, runs whatever the repo
runs, and requests a reviewer it can justify (CODEOWNERS for the touched files,
else whoever actually worked on them recently, else the pod lead). Anything
needing product judgement, or touching auth, money, schemas or behaviour, is not
small: it raises the ticket and leaves the code alone.

Configure it once (admins):

```
//bot ticket config                        what is set
//bot ticket config tracker <notion url>   the database tickets go in
//bot ticket config sop     <notion url>   how-to-raise: naming, fields, priority
//bot ticket config pods    <notion url>   who owns what, for routing
//bot ticket config repos   my-org             every repo in that org
//bot ticket config repos   my-org, other/repo an org, plus one specific repo
```

`repos` takes whole organisations as well as single repositories. An org covers
everything under it, including repos created later - so before pushing, the bot
confirms with `gh repo view` that the repository really is under a listed org
rather than trusting a similar-looking name.

With no tracker set it refuses to raise anything, and with no repos set it never
opens a PR. Nothing about any particular workspace lives in this codebase.

## Review policy per repo

By default `quick-review` posts "reviewing", runs the review, and approves only once
it has come back clean. A repository can opt in to the faster order instead -
approve immediately and reverse that with a request for changes if the review
turns up something blocking:

```
//bot review-policy owner/repo after      approve only after a clean review (the default)
//bot review-policy owner/repo first      approve up front, reverse on a blocker
//bot review-policy owner/repo default    clear it
//bot review-policy                       the default, and every repo that differs
```

On `after`, the up-front approval is skipped, the brain is told plainly that
nothing is approved (so the review is not written as a formality), and once it
finishes the approval is decided by **asking GitHub** for the PR's review
decision rather than inferring it - `CHANGES_REQUESTED` means no approval, and
it says so in the thread.

### CI comes first

Whichever policy it is on, `quick-review` reads the PR's checks before anything else:

| CI | `first` | `after` |
|---|---|---|
| red | request changes at once (the body and the thread name the failing checks), then review and comment as usual. Never approved | the same |
| green | approve up front, then review | review, then approve if it came back clean |
| running | start a CI watcher, approve up front, then review. If CI later goes red the watcher requests changes | start a CI watcher, review. At the end: clean and CI green approves, a blocker or red requests changes, CI still running waits for the watcher - green approves, red requests changes |

A blocker found by the review still requests changes on top of that, exactly as
before. The watcher is a row on the same timer as `watch` (so it shows in
`watch list`), runs outside any turn, polls once a minute and gives up after an
hour (it says so, and approves nothing). It is idempotent: it will not
approve or request changes twice, it does not request changes on a PR that is
merged or closed, and it never approves while the review is still being
written. A watcher cut loose by a bot restart waits out its hour and does not
approve, since whether the review had finished is only known in memory. A PR
GitHub cannot be read for, or one without checks, goes the old way; no checks at
all counts as green. `watch cancel` in the thread ends the watcher too.

Policies are configuration, in the database: no repository is named anywhere in
this codebase, which matters because it is open.

One run can ask for a different policy without changing anything:

```
//bot quick-review <pr-url> --policy after     hold the approval back, this run only
//bot quick-review <pr-url> --policy first     approve up front, this run only
//bot quick-review <pr-url> --policy default   the built-in default, this run only
//bot quick-review <pr-url> --after            the same, shorter
```

Nothing is written down, so the repository stays on its own policy for the next
review. Asking for the **stricter** run is anyone's call. Asking for the looser
one - approving up front on a repository that deliberately waits for a clean
review - overrules an admin's decision, so it takes an admin. A value that is
not a policy is refused rather than quietly ignored, since a review that ran on
a policy you did not ask for is worse than one that did not run.

It does not collide with the free text. `--policy` and `--policy=x` are flags
wherever they appear and are taken out before the note is built; `policy:x`
counts only when `x` really is a policy, so "check the `policy:handler` code"
stays a note rather than refusing the command. Bare words are just words -
"approve after CI is green" asks for nothing. With several PRs the flag applies
to the whole run whatever order it was typed in.

## Reading what its own credentials cannot see

The bot speaks with its own Slack token, so everything it says arrives under its
own name. The cost is that it only sees what it has been invited to - a channel
or group DM it is not a member of returns `channel_not_found`.

```
//bot read <slack link or #channel> [what you want from it]
```

`read` (aliases `summarise`, `catchup`) opens it through the account's
connectors - Slack, Notion, whatever else is authorised - which see what the
authorising human sees, and reports back in the thread. A private Notion page
linked from a Slack thread is the normal case, not an exception.

"Private", a 403 or an empty page means the **credentials are wrong**, not that
the thing cannot be read. And a hand-rolled `curl` at a private service's
internal API is never the way to find out: it returns an empty body, which
proves nothing. **Owner only**, and not out of timidity: it reads with that person's
access, so whoever can run it can read anything they can - private channels and
DMs included.

Reading through the connector is allowed; **posting through it never is.** A
message sent that way arrives under the human's name rather than the bot's, so
the connector's send, schedule, draft and canvas tools are denied to every role
including full access. The ban used to cover the whole connector, which refused
the harmless half along with the harmful one.

## Desktop access

Some things the bot can be asked to do reach the desktop - taking a screenshot,
closing a window. On macOS that needs the Accessibility permission, which is
granted against the **path of the binary that launched the process**. Under
launchd that is the runtime (`bun`), not `claude` and not a terminal, which is
the first thing people get wrong: a terminal usually has the grant already, so
testing by hand succeeds while the bot still cannot.

The second thing is worse. The grant follows a path, and a package upgrade that
installs into a versioned directory moves the binary - the permission then
silently stops applying, weeks before anyone asks for a screenshot and gets a
confusing refusal.

So it is probed rather than assumed: `AXIsProcessTrusted()` at boot and on a
five minute TTL, logged at startup and reported by `GET /health`. Not by
scripting System Events - that answers a different question (Automation), which
can be granted while Accessibility is not, and reported "allowed" while the real
call was being refused:

```json
{ "ok": true, "slack": "listening, connected for 2m",
  "ui": "desktop UI control: REFUSED - the Accessibility permission is missing or no longer matches this binary (an upgrade moves it). Grant it to /opt/homebrew/bin/bun",
  "uiState": "denied" }
```

It never affects `ok`. Nothing core needs the desktop, which is exactly why its
absence would otherwise go unnoticed - and a probe that fails for some other
reason reports `unknown` rather than blaming a permission.

## The inner child

An always-on part that reads the bot's own finished turns every ten minutes.
Set `inner_child_channel` (a setting) to turn it on, `inner_child=off` to pause.

- **Defects in the bot itself** are filed and fixed by the bot in that channel,
  announced before and after, at most four fixes a day. At most 10 are open
  (queued or being fixed) at once; while the queue is full, triage files
  nothing new and logs it. A queued issue nobody got to in 7 days is closed
  with state `stale` (the row is kept, its fingerprint still dedupes).
- **Voice drift** - a final reply that starts a paragraph with a capital (`I`
  and acronyms excepted), uses an em/en dash, a semicolon, an arrow, a markdown
  heading or `**bold**`, or answers in a different language from the thread -
  is never fixed in code and the reply is never edited. The session that wrote
  it gets a private nudge in its own thread to re-check that reply's content
  and correct anything wrong in a new reply; only that correction appears.
  Each event is a `drift_events` row, an activity log line, and a message in
  the drift log channel with the nudge, followed by the session's answer in its
  thread. The channel is the `inner_child_drift_channel` setting, falling back
  to `DRAIN_NOTICE_CHANNEL`; `off` turns drift steering off. One nudge per
  reply, at most 12 a day, never in a workflow thread.

## Staying online

Socket Mode fails in a way that looks like health from every angle: the process
stays up, the supervisor reports it running, the dashboard answers, and the logs
go quiet - which is indistinguishable from a quiet afternoon. Twice that has
been a multi-hour outage nobody could see, because `KeepAlive` only revives a
process that has actually **exited**.

So the connection watches itself. If the socket is not connected and has not
come back within three minutes - including a client stuck reconnecting forever,
which is what both outages actually were - the process exits and the supervisor
starts a fresh one. A blip that heals in seconds is left alone.

`GET /health` reports whether the bot can **hear Slack**, not whether it is
running:

```json
{ "ok": false, "slack": "NOT listening - reconnecting for 14m", "state": "reconnecting" }
```

It answers `503` when deaf, so an uptime check sees an outage instead of a
process that happens to be alive.

## Stuck work

Every 15 minutes, outside any turn, the bot looks for work that died without
saying so: Orca tasks still `dispatched` whose worker is gone (its terminal
exited, it settled without reporting, or Orca no longer knows the dispatch),
and open PRs on its own repo with no commit, comment or review for 30 minutes
that are not simply waiting on a person (an approved PR, or one ready for review
with every check green, is the reviewer's to move, so it is not reported).
It DMs the owner (`OWNER_SLACK_ID`) one short message listing what is new, each
with the Slack thread that started it (recorded when the bot opens the PR), and does not repeat an item for 4
hours - a restart does not reset that. When Orca or `gh` cannot be asked it
says nothing rather than claim all is well; `mindful` shows the same lists on
demand, with a "could not check" line when that happens.

## Stale promises

A turn sometimes ends with "next I will update the post" (or "việc tiếp theo là
...", "xong em gửi ...") without setting a watch, a reminder or a worker, so
nothing is left to do it and the thread goes quiet until someone prods it. Every
15 minutes, outside any turn, the bot looks at the threads it spoke in during the
last 24 hours. A thread counts as a stale promise when the newest message is the
bot's own and is over 30 minutes old, no turn, workflow, watch, reminder or live
Orca worker is attached to the thread, and that message really promises more work
(a cheap English + Vietnamese check, then one yes/no question to the small model;
a question to the person, an offer or a finished answer is not a promise). The
bot then steers that thread's own session once, the same internal turn `tell`
uses: do the work now, set a watch, or end with `NO_REPLY` if nothing is pending.
The sweep itself posts nothing to Slack and nobody is DMed. A message is nudged at
most once, even across restarts, a thread is nudged again only after a person has
spoken in it, and at most 3 threads are nudged per sweep.
`STALE_PROMISE_INTERVAL_MS=0` turns it off.

## How the brain runs a command

The brain can run the bot's own commands for whoever it is talking to (and its internal ones, like `journey`, which nobody else may run). It never
names the actor - the bot mints a one-turn **ticket** bound to the current
speaker, and the command runs as them.

The ticket lives in the spawned CLI's **environment**, not its prompt. That is
not a detail: a thread holds one long-lived session, so every system prompt it
was ever handed is still in its context. A ticket printed there is one the model
will eventually retype from memory - expired by then, since tickets have a TTL,
a use count, and die with a restart. When that happens every command in the
thread comes back `that ticket is not valid any more` and nothing said inside
the conversation can fix it.

It also closed a worse door. A remembered ticket belonged to whoever was
speaking when it was issued, so reusing one would have run a command as somebody
else - exactly the escalation the ticket exists to prevent.

A process environment cannot be stale: it was set when the turn began.

**What the thread sees.** A command a person types shows its output in the
thread. A command the brain runs on its own (checking `mindful`, a status) is
hidden: the output goes back to the brain only and nothing is posted. When the
person directly asked for the command ("bomb that message"), the brain runs it as
`jarvis-run.sh <endpoint> --show <command>` and it shows like a typed one.
The bridge refuses `quick-review` outright, whoever asked: that command runs only from a person's own message. Commands that post by themselves outside this bridge (pickers, GitHub reviews)
are not affected.

## Secrets and turns

A turn is a `claude -p` process whose shell a model drives while it reads text
nobody vetted: messages, web pages, files. Anything in that process's
environment is one `env` or one `curl` away from leaving the host, and the bot
used to hand every turn a copy of its own environment - `SLACK_BOT_TOKEN`
included - and tell it to `curl` Slack with it.

**The environment.** A turn gets the bot's environment minus every
credential-shaped variable: any name with a `TOKEN`, `SECRET`, `PASSWORD`,
`API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY` or `CREDENTIAL` word in it, a password glued to a
prefix (`PGPASSWORD`), or a `_KEY`, `_PAT`, `_PWD` or `_AUTH` ending. That is a rule
by name, so a `*_TOKEN` you add to `.env` later is withheld without a code
change. Two things stay: `CLAUDE_CODE_OAUTH_TOKEN` (the CLI cannot authenticate
without it) and whatever you list in `TURN_ENV_PASSTHROUGH`. The boot log says
how many variables were withheld and their **names**, never their values.

Withheld from every turn: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`ANTHROPIC_API_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, and the variables that only
name where a secret lives (`TOKEN_KEY_PATH`, `TOKEN_DATABASE_PATH`,
`GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_WEBHOOK_SECRET_PATH`, ...), plus any
other credential-shaped variable in the environment the bot was started with.
If `LLM_PROVIDER=claude-cli` is authenticated by `ANTHROPIC_API_KEY` instead of
the recommended `CLAUDE_CODE_OAUTH_TOKEN`, add it to `TURN_ENV_PASSTHROUGH`.

**Slack.** A turn calls Slack through `bin/slack-api.sh <method> key=value...`.
The helper presents `JARVIS_SLACK_TICKET`, a ticket minted for that one process
when it starts and revoked when it exits, to the bot's loopback endpoint
(`POST /api/slack/proxy`). The bot checks the ticket, checks the method against
an allowlist and calls Slack with the token it holds; Slack's own answer comes
back unchanged. The ticket names no person and carries no role: it cannot run a
command or act on GitHub, and a command ticket cannot call Slack.

| | methods |
|---|---|
| read, any channel | `conversations.history`, `conversations.replies`, `conversations.info`, `conversations.list` (public channels), `conversations.join` (public channels), `users.info` |
| write, only the channel the turn runs in | `chat.postMessage`, `chat.update`, `reactions.add`, `files.getUploadURLExternal`, `files.completeUploadExternal` |
| files | a private file is `bin/slack-file.sh`, through `POST /api/slack/file`: Slack file urls only, and the token never follows a redirect off Slack |

A `chat.postMessage` or `files.completeUploadExternal` from a turn that runs in a
thread and names no `thread_ts` is posted into that thread; pass `thread_ts=none`
for a deliberate top-level post (the bot removes it before calling Slack), and an
explicit `thread_ts` is used as given.

Anything else is refused (`method_not_allowed`), a write to another channel is
`channel_not_allowed`, and a missing, revoked or expired ticket is refused before
anything else. `slack-read.sh`, `slack-react.sh`, `slack-file.sh` and
`slack-upload.sh` are built on the same helper, so a sandboxed role has no more
power than before (reacting and uploading now only work in the turn's own channel). A watch predicate and a loop script are admin-written shell
that runs **as the bot**, so they keep the bot's own environment; `watch reply`
gets a read-only ticket for the length of each check.

**What this does not do.** It takes the token out of the turn's environment.
Reads are not channel-scoped, so a turn in a public channel can still read a
private conversation the bot is in and write it into that channel (the token
allowed the same before). A full-access turn is still the host user: it can read `.env` and the token files
off disk, and the dashboard's loopback API has no authentication, so it can reach
the console routes (`/api/slack/post`, ...) with `curl` and act as the bot in any
channel. Closing those is a separate decision about what a full-access turn may
read and call.

## Stopping a turn

A chat turn can run for the better part of an hour, so there is a way to end one
that is going the wrong way instead of waiting it out.

Send anything while a turn is running and the thread says nothing: the message
queues silently and runs when its turn comes. There is no "still working on ...
yours is next" notice. To end the running turn, press Slack's own stop button on
the session, or use `//bot stop`.

`//bot stop` ends the turn from a thread without needing a new message: a turn
going wrong while you have nothing to add.
It also ends the background agents the thread's turns started outside their
own process - `claude --bg` sessions and Orca workers, from this turn or an
earlier one - and says what it stopped ("stopped the turn, and 1 background
agent it started"). They are found from the thread's tool log (the launch
command and the id it printed) and stopped with `claude stop` /
`orca orchestration worker-stop`, never by killing processes, so nobody
else's session is touched. Background agents started with the Agent tool run
inside the turn and end with it.

Your own turn is yours to stop. Stopping someone else's takes an admin, because
a turn is their work and - with per-user tokens - their money. A button that
outlived its run says so rather than failing: it sat in the channel while the
work finished on its own.

A stopped turn is **not** reported as a failure. It is killed the same way a
timeout kills one, so without care it would come back as "ran past my time
limit"; whoever stopped it already knows, and the thread has been told.

## Orca workers' questions

An owner turn that starts an Orca worker (`orca orchestration worker-start`; no other role may) is that
worker's coordinator, through the bot's own Orca terminal - a bare shell, so
nobody would see a question the worker asks, and it would wait forever. The
bot links every worker to the Slack thread whose turn started it (chat or
workflow; a GitHub App turn has no thread and is not linked), reads each such
Run's mailbox every 30 seconds, and puts any question still waiting to that
thread as a turn opening with `[orca question]`. The turn answers it with
`orca orchestration reply` from what the thread knows, or picks the safe
option and says so; it never waits on the thread. Each question is delivered
once, a delivery a restart cut is retried while the question is still open,
and an answered question or a finished worker gets no turn. In a workflow
thread the question goes to the workflow's worker session, not the front,
since only the worker can run `orca`.

## What an Orca worker cost

Orca keeps no tokens, cost or session id for a worker, so the bot reads them
from the worker's own Claude Code transcript: `worker-read --source
transcript` gives one of its message ids, and that id is the `uuid` of a line
in `~/.claude/projects/<worker folder>/<session>.jsonl` (`$CLAUDE_CONFIG_DIR`
moves the root). The session and its subagents' transcripts are summed, each
API message once, and priced per model at list price (input, output, 5-minute
and 1-hour cache writes and cache reads apart; the one price table is
`MODEL_PRICES` in `src/domain/workerUsage.ts`). When a `watch worker` fires on
a worker that finished or died, the hand-back says what it used and the turn
says it in the thread; the figure is stored in `orca_worker_usage`.
`worker-cost <ctx_...>` answers later (from the stored figure once Orca has
forgotten the dispatch), and `worker-cost <run_...>` totals a Run. Nobody is
invoiced this on a subscription; it is what the work would cost at API prices.

## Followed threads: wait, then ask a cheap model

The bot answers untagged messages in a thread it follows (one it started, or one
somebody pointed it at with `follow`). It used to run a full main-model turn for
each message and let that turn decide to stay quiet, which is the expensive way
to say nothing, and replies burst when people sent several lines in a row. Now
those messages wait in a short per-thread buffer first:

1. Every new message in the thread resets a quiet window (default 25s). A hard cap
   counted from the first buffered message (default 90s) means a busy thread is
   never held for ever.
2. When the window ends, a cheap model (the `pal` model, Haiku by default, no tools)
   reads the batch plus the few messages before it and answers `reply`, `skip` or
   `wait`, with a short reason. `wait` buys one more quiet window, still under the
   cap; at the cap `wait` counts as `reply`. When unsure it answers `reply`, and an
   error, a timeout or an answer that cannot be read is a `reply` too.
3. Only `reply` runs the main turn, once, with every buffered message in order and
   who wrote each.

Never held, and handled exactly as before: tagged messages, DMs, threads that are
just the bot and one person, command lines (`//bot ...`) and spoken review
requests (those are only ever a tag: an untagged reply is never one). A message from somebody off the allowlist is not buffered either. A
one-on-one thread is recognised from the thread itself (the bot has written and
exactly one human has), not from why it is followed: it is followed for good from
its second message on, which makes its route read "asked", and it must still never
wait.

A message that is not held is answered at once, and takes over whatever the thread
had buffered only when it will itself run a chat turn for an allowed user (allowed,
not a command line, has text beyond the tag): that turn reads the buffered messages
in its thread context, so the pending batch is dropped and its inbox rows settle,
and it cannot fire later into a second, out-of-order answer. A message from
somebody off the allowlist (untagged, or an @-mention that becomes an access
request) and a command line answer none of the buffered messages, so they leave the
batch alone to fire on its own. Past the hard cap the gate never loops: a newer
message arriving while the model reads does not restart the window. Any answer
except `skip` replies with the whole current batch; a `skip` settles only the
messages the gate actually read (they were skipped) and carries the unseen ones
into a fresh batch with a new cap, so a skip never swallows a message the model
did not see and a busy thread cannot hold its rows open for ever. The batch runs as its least-privileged author (role, tools and access), so a
lower-role request plus a higher-role "+1" in the same window never runs on the
higher role's tools. A turn that fails marks its rows failed, not done.

A restart does not lose the buffer: a message's inbox row stays open until its
batch is answered or skipped, so after a restart the row is redelivered and the
message is buffered again.

**Settings** (the `settings` table, edited like `follow_own_threads`; read per
message, so a change needs no restart):

| key | default | meaning |
| --- | --- | --- |
| `follow_gate` | on | `off` goes back to one main turn per message |
| `follow_debounce_seconds` | `25` | quiet time after the latest message before the batch is judged |
| `follow_debounce_max_seconds` | `90` | longest a batch is held, from its first message (at most 600) |

Not a number, or not above zero, means the default; the cap is never shorter than the
quiet window. The gate uses the model for the `pal` role (`CLAUDE_MODEL_PAL`, or
`model:pal`), see [Model per role](#model-per-role-and-per-channel).

**Tuning.** Every decision logs one line, including `skip`, so you can see what the
gate is keeping quiet about:

```
follow gate channel=C0123 thread=1731.0001 batch=3 verdict=skip: people are talking among themselves
```

A line for a window that was extended, a verdict that was superseded by a newer
message, or a gate that timed out says so in parentheses. If it skips things it
should have answered, read the reasons first (the prompt is `gateSystem` in
`src/domain/followGate.ts`), or set `follow_gate=off` while you decide. If replies
come too late, lower `follow_debounce_seconds`.

## One turn at a time

A thread's turns run one after another, never beside each other. Two messages a
few minutes apart used to spawn two independent runs that each did the whole
task: two branches, two implementations, two pull requests, neither aware of the
other.

It is also what the session model requires - a thread holds one CLI session, and
two `--resume` processes on one session id are two conversations overwriting
each other's history. Queued this way, the second message runs with the first's
result already in the session, which is what makes a follow-up mean "and the
rest" rather than "again, from scratch".

If something is already running, the thread is told so rather than going quiet.
Commands are deliberately not queued: a review is its own process with its own
session, and holding one behind a long chat turn would make it look dead.

## One session per thread

A Slack thread is one conversation, so it gets **one Claude Code CLI session**.
The first message in a thread opens it (`--session-id`), every later one resumes
it (`--resume`), and the model keeps its context, its reasoning and its files
between turns instead of starting cold and being handed a transcript each time.

A resumed turn is given only what it has not seen: everything said in the thread
since its last turn, including messages the bot was not addressed in. The bot's
own SQLite memory still records every turn - it is the fallback when a session
is gone, and what the dashboard reads.

Sessions are keyed by **thread and access tier**, not thread alone. Full-access
(`tools:full-access`, the owner as seeded) and sandboxed roles run the CLI in different
working directories, and the CLI files a session under the directory it ran in -
so they could not share one in any case, and sharing would hand a sandboxed user
whatever a full-access session had read.

A session that will not resume is not an error anyone sees: the CLI prunes its
own history and a committed database outlives the machine it was written on, so
`No conversation found with session ID` means "start a fresh one and read the
thread back in", silently. A genuine failure still surfaces.

```
//bot session          what this thread is on
//bot session reset    drop it; the next message starts fresh
//bot session off      admins: back to a cold call per turn
//bot session on       admins: back on
```

## Calling it from GitHub

A GitHub App lets people call the bot where the work is. Mention it in an
issue or PR comment, a review comment or a submitted review
(`@<slug> why does this fail?`), or add the `jarvis` label to an issue
or PR. It puts 👀 on the comment, posts the request into a Slack channel
(`github-app channel #channel`, else the review inbox channel) and runs a turn
in that post's thread **as the person who called**, matched like the review
inbox does (`review-inbox link <github-login>`, else exactly one display-name
match), so their role and their own Claude token apply. Someone it cannot
place gets one comment explaining how to link, and nothing runs.

The turn posts its answer back on the issue/PR, as the app, through
`bin/github-app-comment.sh <owner/repo> <number> <body-file>` -> loopback
`/api/github-app/comment`. The request carries the turn's ticket, and the bot
only posts to the issue that turn's thread was opened for. If the turn ends
without posting, its reply is posted for it.

For anything wider, a turn can act as the app on any repository it is installed on
(`acme`, `cute-me-on-repos`, ...) when the person it runs as holds the action's grant
(`github:<action>`, one per action below: `git` and `push` are separate grants, and `push`
must use the `push` subcommand). As seeded that is the **admin and the owner** (all twelve), and the **executer** for `git` (commit as the app, **identity only, no token**: a role gets the installation token only when it also holds `github:push`), `pr-create`, `pr-edit`, `comment`, `labels-add` and `reviewers-request` - never push, review, merge or close. The owner
grants any of them to another role (`role grant executer github:pr-create github:comment`)
with no code change:

```
bin/github-app.sh pr-create <owner/repo> --head <branch> --base <branch> --title <t> --body-file <f> [--draft]
bin/github-app.sh comment <owner/repo> <n> <body-file>
bin/github-app.sh review <owner/repo> <n> APPROVE|REQUEST_CHANGES|COMMENT [body-file]
bin/github-app.sh pr-edit <owner/repo> <n> [--title <t>] [--body-file <f>]
bin/github-app.sh pr-close|pr-reopen <owner/repo> <n>
bin/github-app.sh pr-merge <owner/repo> <n> [--method merge|squash|rebase]
bin/github-app.sh labels-add|labels-remove <owner/repo> <n> <label>...
bin/github-app.sh reviewers-request <owner/repo> <n> <login|team:slug>...
bin/github-app.sh git <owner/repo> <local-repo-dir> -- <git args>...
bin/github-app.sh push <owner/repo> <local-repo-dir> <branch> [--force-with-lease]
```

`git` runs `git -C <dir> <args>` **as the app**: commits and cherry-picks are
committed by `<slug>[bot]` (`<id>+<slug>[bot]@users.noreply.github.com`,
no GPG signing; the id is looked up once with `GET /users/<slug>[bot]`), and
anything that talks to github.com (fetch, pull, push, ls-remote; an ssh remote
is read as https) carries a fresh installation token. `push` pushes one branch
to the remote of `<dir>` that points at `<owner/repo>`. The token is a one-shot
credential: the bot hands it back for the `git-auth` action (same ticket, same
grant gate (an executer gets the identity with no token, so it can commit but not push), same command log row, no token in the log) and the helper puts
it in that one git process's environment as `http.extraheader` through
`GIT_CONFIG_*` - never in a remote url, `.git/config`, argv or any file. A
cherry-picked commit keeps its original author unless you pass `--reset-author`.

```
bin/github-app.sh git acme/acme-api ~/Workspaces/be -- commit -m "fix: x"
bin/github-app.sh push acme/acme-api ~/Workspaces/be fix/x
```

In the `acme` org, every PR is committed and opened as the app
(`git` + `push` + `pr-create` above); review comments and the merge are done as
`kai-at-acme`.

**Orca workers** outlive the turn that started them, and a turn's ticket is
gone after 20 minutes, so a worker gets its own scoped one. In the turn (a role holding
`command:worker-ticket`, admin and owner as seeded, through the run helper; the command refuses anything that is not the
brain's own run bridge, so a typed line, a schedule, an errand or the menu never
mint one):

```
worker-ticket <owner/repo> pending [pr-create|comment|pr-edit|push|labels-add|reviewers-request ...] [--ttl 3h]
worker-ticket bind <id> <ctx_...>      # after worker-start prints the dispatch id
worker-ticket revoke <id|ctx_...>
worker-ticket renew <id|ctx_...> [--ttl 3h]   # admin; also revives one that lapsed but was never revoked
```

The result holds `JARVIS_RUN_TICKET_FILE=<path>`, **never the token**: the token
is written once to a mode-0600 file in a 0700 folder
(`~/.config/jarvis/worker-tickets/<id>`) and the worker brief carries only the
path, to `export` before `bin/github-app.sh` (the helper reads the first line of
that file; the brain never reads, prints or posts it, and the file is deleted
when the ticket ends). The ticket works for that one repo and those actions only
(default `pr-create`, `comment`, `pr-edit` and the app's commit identity; never review, merge or close), cannot
run any command, is checked against the minting person's role on every call,
expires in 3 hours (max 6) and ends when the worker finishes or dies (the turn's
`watch worker`), on `worker-ticket revoke`, or at expiry. Tickets are rows in
`worker_tickets` (only the sha-256 of the token), so they survive a restart; a
sweep at boot and every 5 minutes ends the expired ones. No new setting.

**The worker finds the bot through its ticket file.** The file holds the token on
line 1 and the bot's loopback URL (`http://127.0.0.1:<DASHBOARD_PORT>`) on line 2,
because a worker's shell has no `DASHBOARD_PORT`. `bin/github-app.sh` and
`bin/github-app-comment.sh` use, in order: `GITHUB_APP_ACTION_URL` /
`GITHUB_APP_COMMENT_URL`, `DASHBOARD_PORT`, line 2 of `JARVIS_RUN_TICKET_FILE`,
then 2001. A ticket file written before this has one line and keeps that default.
Line 2 is followed only if it is `http://127.0.0.1:` plus digits and nothing else
(anything like `http://127.0.0.1:1@evil.example` is ignored, since the ticket is sent
there). A call the bot does not answer prints the endpoint it tried;
`GITHUB_APP_PRINT_ENDPOINT=1` prints it and exits without sending anything.

**Long workers renew.** A worker that outlasts its TTL extends its own live ticket
with `bin/github-app.sh ticket-renew <owner/repo> [--ttl 3h]` (default 3h, at most
6h per renewal; an expired ticket cannot renew itself). An admin can run
`worker-ticket renew <id|ctx_...>`, which also works on a ticket that lapsed but
was never revoked (its worker is still running): such a ticket keeps its token
file until the limit instead of being deleted at its expiry. Nothing lives past
24 hours from the bind however often it is renewed, and every renewal is
audited like a mint.

**Commits come as the app by default; pushing does not.** Every worker ticket
carries the app's commit identity (`git-commit`: name and email, an empty
token), so `bin/github-app.sh git <owner/repo> <dir> -- commit ...` works as the
app for a worker minted with no extra words (the helper runs git with that
identity and no credential, exactly like an executer). A worker pushes with the
org's own one-shot human credential (the `kai-at-acme` of the rule above; where
the app has Contents read-only it cannot push anyway). `push` (the same as
`git` / `git-auth`, the `git-auth` action) stays an explicit opt-in for an org
where the app has Contents write: only then does the ticket get a token. A
ticket row stored before this change keeps what it was minted with (one without
`git-commit` still cannot run `git`; one with `git-auth` still gets its token). Its token is minted
per ticket, never cached or shared, limited to that one repository and to
`metadata: read` plus `contents` at the level the installation itself holds
(asking for more than the installation has is a 422), so it cannot approve,
merge, label or comment on its own. It is revoked at GitHub
(`DELETE /installation/token`) when the ticket ends.

What is still not covered, said plainly: the held GitHub token lives in the
bot's memory, so after a bot restart the token minted before it can no longer be
revoked and runs out on its own (at most 1h from its mint, one repository,
contents/metadata only); a token the worker copied somewhere is only killed by
the events above, and `watch worker` polls every 3 minutes, so a worker that
dies is noticed up to that late; and the token file is protected by file mode and
by the tool policy (pal and executer may not `Read` `~/.config/jarvis/**`), not
by the OS: an Orca worker runs as the same host user as the bot, so any other
process of that user, or a turn that reaches a shell, can read it for as long as
the ticket lives.

It only acts on owners in `GITHUB_APP_ALLOWED_OWNERS`. It posts to `/api/github-app/action` with the turn's ticket (from
`JARVIS_RUN_TICKET`, never an argument); the bot resolves it to the person the
turn runs as, refuses unless their role allows that action (admin/owner: all, executer: the list above), logs the call in the
command log, and prints GitHub's JSON (url, number) or GitHub's own error (app
not installed, permission missing).

Setup: the webhook listener binds `127.0.0.1:GITHUB_APP_PORT` (2003) and only
starts when the app id, private key and webhook secret are found. Tailscale
Funnel maps `https://<host>/github` to it; `/github/webhook` and `/webhook`
both work, as do `/github/setup` and `/setup`. Deliveries are verified with
`X-Hub-Signature-256`, answered 202 at once, deduped on `X-GitHub-Delivery`,
and only acted on for repositories owned by `GITHUB_APP_ALLOWED_OWNERS`.
Bots, the app itself included, never trigger it.

## Asking for a review in words

A quick review runs only when a person asks for it directly, in one of two ways:

- tag the bot with `@bot review <pr-url>` or `@bot approve <pr-url>` - both
  mean the same `quick-review` (there is no approval without a review, and the
  old bare `approve` command is gone);
- type the command: `//bot quick-review <pr-url>` (alias `rv`, slash `/rv`).

Any allowlisted human may ask (`pal`, `executer`, `admin`, `owner`: the command
is `pal`+, and `pal` is the lowest role). The tag has to open the message, the
first word after it has to be `review` or `approve`, and it has to carry a real
pull request url - anything vaguer stays a conversation, because a review spends
the asker's own credential rather than being free.

It is never run for anything the bot or a thread's own flow started: not for the
brain (`jarvis-run.sh` refuses `quick-review`, and the prompt says so), not for a
`tell`, a watch hand-back, a worker's question or a drift nudge, not for a
workflow step or a thread with a workflow running, not for a batch of buffered
follow-up messages, not for an untagged reply under a followed thread, and not
for a GitHub review request (the review inbox only announces it, with the line to
type). A bare PR link typed after the prefix is not a review either.

This matters beyond convenience: only the command can offer the box that takes a
Claude token, so a spoken request used to get a description of the token instead
of the button that accepts one.

Flags carry through (`@bot review <url> --policy after`); the rest of the
sentence does not. "can you please" is not guidance, and guessing which half of
a sentence was meant as an instruction is worse than not trying - typed with the
prefix, the free text is the steering note.

## Your own Claude token

`quick-review` runs the Claude Code CLI, and the CLI bills whoever's token it is
holding. Running every review on the bot's credential puts the whole team's
usage on one account, so a review runs on **the caller's own token** instead,
and refuses to start without one.

Mint one with the Claude Code CLI:

```
claude setup-token
```

It opens a browser, logs you in, and prints a token starting with
`sk-ant-oat01-`. Paste it into the box the bot opens - the button on its "I need
your token" message, or `/<slash> token` any time. **Never type a token as a
Slack message**: the bot only ever accepts one through a modal, whose input is
not a message, is not in anyone's history or search, and never reaches the bot's
own conversation memory. A token pasted into a channel should be treated as
burned and rotated.

Submitting a token also resumes whatever it interrupted - the button carries the
command, so the review you asked for runs the moment the token lands.

**You are asked once.** The full walkthrough goes out one time per person; a
later review with still no token gets a single line pointing back at the box
rather than the whole thing again. Adding (or removing) a token resets that, so
someone who clears theirs gets a proper ask next time.

There is **no fallback to the bot's own credential** for a review. No token, no
review - and when a caller's token is in play it *replaces* the bot's in the
child process rather than being added alongside it, so the bot's token is not in
that environment at all, including for anything the run spawns in turn.

Once a token is on file it is used for **every** CLI turn that person drives:
their chat, their commands, their workflow sessions. Everyone else keeps running
on the bot's own credential, so nobody is locked out of chat by a credential they
never set up. Only `quick-review` insists.

```
/<slash> token           add or replace yours (opens the box)
/<slash> token remove    forget it; your next review will ask again
/<slash> token who       admins: who has given me one (never the token itself)
```

Tokens live in their own database (`TOKEN_DATABASE_PATH`, default
`data/tokens.db`), encrypted with AES-256-GCM under a key in `TOKEN_KEY_PATH`
(default `data/tokens.key`). Keep the database outside the checkout like the main
one; **the key is gitignored**, so a backup of it is ciphertext and a copy taken
from anywhere but the host opens nothing.

On macOS the key can live in the login Keychain instead of a file:
`TOKEN_KEY_SOURCE=keychain` (service `TOKEN_KEY_KEYCHAIN_SERVICE`, default
`jarvis-token-key`, account = the login user; read and written with the
`security` CLI). First boot in that mode:

- Item missing, key file present: the file key is copied into the Keychain, read
  back and compared byte for byte, and only then is the file deleted. A mismatch
  aborts the boot and keeps the file.
- Item missing, no file: a fresh key is created only if the token database has no
  rows. If it has rows, the boot fails: a new key over existing ciphertext would
  orphan every token, so restore the key instead.
- Keychain locked or unreachable (e.g. a reboot before login): the boot
  **continues**, with per-user tokens and 2FA seeds switched off until the next
  restart. Reviews then say there is nowhere to keep a token, and the log has one
  `[token-key] WARNING` line naming the cause. Unlock the Keychain and restart.

The key is written through `security -i` on stdin, so it never appears in a
process's arguments, and it is never logged. A leftover key file next to an item
holding the same key is deleted at boot (an interrupted move is finished); two
different keys abort the boot. The key is not in git and
not in `data/` any more, so back up the Keychain item (Keychain Access, or
`security find-generic-password -s jarvis-token-key -w`) instead of a file.

## What a review comment looks like

Blockers only (except for the owners in `REVIEW_EXTENDED_OWNERS`, see below). One line saying where it lands - good to merge, or what blocks -
then one short bullet per blocker, worst first: what is wrong, one pointer
(`file.ts:120` or an identifier, never a code block or a quoted line), why it
matters. A clean PR gets that one line and the sign-off.

Blocking means a security hole, data loss, a breaking change, a correctness bug
that would ship, missing or failing tests on a critical path, or failing CI.
Everything else - design, cleanups, style, nits - is never posted, and never
becomes a GitHub issue either: it is dropped.

PRs owned by an account listed in `REVIEW_EXTENDED_OWNERS` (decided per PR from a full url or `owner/repo#N`; empty by
default, so nobody gets this until you set it) are the
exception: non-blocking findings (design risk, correctness, coding style, real
cleanups) follow the blockers as bullets, worst first, under about 250 words for
a normal PR, then one last "out of scope per the description: ... risk left
standing" warning bullet for anything the description defers. They never make
it request changes and never become an issue; pure-noise nits are still dropped.

It reads the description and the existing comments **before** reviewing, so
nothing already said is said again. A gap the description declares out of scope
is never a blocker, but scope covers what a PR does **not fix**, never what it
**breaks**.

## Explaining a review

`quick-review help` describes the flow in a few lines; `quick-review prompt` prints the
actual system prompt it runs on, which is no secret - it is in this repository.

Both exist because the question used to cost a review: asked to explain itself,
the bot ran `quick-review help`, took the word "help" as a target, and spent minutes
reviewing a pull request by that name on the asker's own credential. An argument
now has to look like a pull request - a url, `owner/repo#123`, or a bare number -
before anything expensive starts.

## Steering a review

Anything typed next to the url is guidance, not a second target:

```
//bot quick-review <pr-url> the migration is the risky bit
//bot quick-review <pr-url> hotfix, only care about data loss on the delete path
//bot quick-review <pr-url> check it against GEN-1234
```

It points the review at what you already suspect, which is usually faster and
better aimed than a cold read: the review starts there, weights it, and says
what it found about that specifically.

The note is quoted into the prompt, never merged into the instructions. It can
aim attention and nothing else - it cannot skip a PR, waive the approve/request
flows, invent an approval, change the house style, or have something called
clean that is not. A note asking for something outside a PR review is ignored,
and the review says so in its wrap-up rather than quietly doing it.

## How wide a review fans out

A big PR (more than 5 changed files, or 200+ lines either way) is cloned and
reviewed by child agents rather than from the diff alone. Left unbounded, a
review fans out as wide as the model feels like and then spends its whole
wall-clock budget waiting on the slowest agent - which ends with the run being
reaped by the timeout having posted nothing at all.

So the fan-out is capped at **3** agents, spawned in one parallel batch, and the
brain is told to drop an agent that has not reported rather than let it hold the
review hostage. The cap is configurable:

```
//bot review-agents 5          up to five child agents per review
//bot review-agents default    back to three
//bot review-agents            what it is set to
```

1 to 8; anything else is refused. If a run is still cut off, the thread says so
plainly and shows how far it got, instead of passing the fragment off as the
review.

Dropping an agent means its findings can land after the review is already on the
PR. That case is settled in the prompt, not by asking: a late finding the brain
verifies as blocking gets its own short follow-up comment (announced in the
thread as a follow-up, not as the review again), and anything else gets one line
in the wrap-up. A review runs unattended, so it never ends on a question.

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
//bot limit @casey 25         25 commands per 4h
//bot limit @casey 0          every command needs approval
//bot limit @casey default    back to the default
//bot limit                  your own standing
```

Interactive buttons need the Slack app's **Interactivity** switched on (Socket
Mode needs no request URL).

## Roles & tool access

**Only `owner` is hard-coded**: it always exists, always holds every permission, and can never be restricted, renamed or deleted. Every other role is data in the database - a name, a rank, a description and the permissions it **grants** - that the owner edits with the `role` command or on the dashboard's Roles page, with no code change and no restart. `pal`, `executer` and `admin` are just the roles an instance starts with: on the first boot after upgrading they are seeded with the grants the code used to hard-wire (so nothing changes for anyone), the old dashboard deny lists are folded into those grants, and the old `note_min_role` / `read_min_role` floors become who holds `command:note` / `command:read`. After that you can take a grant from `admin`, give `executer` the GitHub App, or create a `qa` role from scratch.

A permission is an id; `role perms [filter]` and the Roles page list them all:

| permission | grants |
| --- | --- |
| `command:<name>` | running that command (a command's `minRole` in code is only where its grant is seeded) |
| `github:<action>` | acting on GitHub as the App: `pr-create`, `comment`, `review`, `pr-edit`, `pr-close`, `pr-reopen`, `pr-merge`, `labels-add`, `labels-remove`, `reviewers-request`, `git` (commit as the App), `push` (push a branch with its token) |
| `mcp:<server>` | using an MCP server in a chat turn: `notion`, `datadog`, each `DB_MCP_SERVERS` entry, plus any server named on the Roles page. A server a role lacks the grant for is denied by name |
| `tools:full-access` | chat turns run the CLI with full access (real shell, writes, the normal cwd) - the owner alone as seeded. Without it the role is sandboxed: an explicit `--allowedTools` allow-list in a fixed scratch dir, with no permission bypass and `--permission-mode dontAsk` |
| `tools:code` | the sandboxed code tools: clone into the scratch dir, edit, commit, push a branch, open a PR, the `Agent`/`Task` tool for parallel or long work, and the browser tools (the dashboard's code-tier tool list replaces the read-only base) |
| `tools:orca` | starting Orca workers, which run with full host permissions - only the owner as seeded |
| `chat:self-update`, `chat:desktop` | the self-update flow, learn url and watches offered in chat; driving the screen |
| `commands:unlimited`, `commands:approve` | not held back by the per-window command allowance (`pal` is); pressing the approve / reject buttons on a held command |
| `access:decide` | deciding access requests |
| `settings:manage` | the configuration sub-actions of commands: model, review-agents, review policy overrides, logsource, review-inbox moves, ticket config, cloudwatch default group, someone's allowance, `token who`, `note parent` |
| `review:policy`, `runs:stop-any`, `secrets:2fa-manage`, `watch:shell`, `reminders:manage-all`, `cloudwatch:direct` | choosing a review policy; stopping someone else's turn or session; adding and removing 2FA setup keys; shell-check watches (and seeing everyone's watches); everyone's reminders; CloudWatch without the Confirm step |

As seeded: `owner` holds everything. `admin` is sandboxed like an `executer` (never fewer tools than one): `tools:code`, the read-only database servers (`EXECUTER_DB_MCP_SERVERS`), Notion and Datadog, with no arbitrary shell and no permission bypass; on top of that every command at or below admin, all twelve `github:` actions and the admin sub-actions (no `tools:orca`: `Bash(orca:*)` is denied by name). `executer` is sandboxed with `tools:code`, the read-only database servers (`EXECUTER_DB_MCP_SERVERS`) and executer-level commands, the `git`/`pr-create`/`pr-edit`/`comment`/`labels-add`/`reviewers-request` App actions (commit identity only: no `github:push`, so no token). `pal` is sandboxed read-only (GitHub read, Notion read, web, read-only git and aws), may use `quick-review` and react, and is held to the per-window command allowance.

**What cannot be granted** (guardrails, not role ceilings): *managing roles* is the owner's alone - `role` and the Roles page never work for anyone else, and even a hand-edited grant for it does nothing. A role only adds, changes or removes people whose role **ranks below its own** (`role rank`), so an admin still cannot hand out or take away admin, and nobody can be given `owner`. A role cannot grant what its editor does not hold. Everything else that used to be a ceiling is a grant now, including worker-ticket minting (`command:worker-ticket`; the minter's own `github:` grants are re-checked on every call, so demoting them stops their workers) and the Notion, database and Orca limits.

**Switching a role off** treats its members as not on the allowlist for every check in the bot (chat, commands, buttons, GitHub calls), and they are told so rather than raised as an access request. **Deleting** a role is refused while anyone holds it (they are named: move them with `add @user <role>` first) and for the role an approved access request lands on (`role default`, else the least-privileged one). **Renaming** moves everyone who holds it, and its `model:<role>` override, along. A permission added by a later release is seeded into the built-in roles only, never into a custom one, and a revoke you made is never undone.

Only the owner runs the Claude CLI with `--dangerously-skip-permissions`. Every other role runs with `--permission-mode dontAsk` and an explicit `--allowedTools` allow-list; the code-tier list is edited on the Roles page; `SANDBOX_TOOLS` sets the default for the rest. `quick-review` is a preset that always runs full-access (and writes to the PR) for whoever may run it.

**Orca is a grant, and the owner's as seeded.** An Orca worker runs with full permissions on the host Mac, so a role that could start one would step out of its own sandbox. `Bash(orca:*)` (and the installed paths, `ORCA_DENY` in `src/domain/toolPolicy.ts`) is in `--disallowedTools` for every role without `tools:orca`, because an allow-list never refuses - only a denial does. An `executer` still gets a code job done inside its own sandboxed process (clone, edit, commit, push a branch, open the PR) and fans out with the `Agent`/`Task` tool, which is in its tool list in code so the dashboard list cannot drop it. The prompt is role-aware: a role without `tools:orca` is told to use the Agent tool for background work, and to use an Agent for the self-fix reviewer. The denial matches the command as typed, so `bash -c "orca ..."` is not caught.

**Extra denied tools**: each role can also carry CLI tool patterns (`Bash(rm:*)`) it is refused whatever it is granted (`role denytools`, or the Roles page). `owner` is never restricted.

Two more helpers are granted to every role for the same reason: `bin/slack-file.sh` (downloads a Slack attachment, and refuses any url that is not a Slack file) and `bin/jarvis-run.sh` (asks the bot to run one of its own commands, gated by the caller's role).

**Driving the desktop** goes through `bin/desktop.ts mac-ui|agent-desktop <args>`, which holds a desktop-wide lock per session (`JARVIS_DESKTOP_LOCK`, default `<tmpdir>/jarvis-desktop.lock`) so two threads never click into each other's windows. A busy screen exits 75; `desktop.ts free` exits 0 when the caller may act, `status` shows the holder, `release` gives it back. An idle lock lapses after 5 minutes.

Some tools are **denied to every role, full access included** - `--disallowedTools` is honoured alongside `--dangerously-skip-permissions`, so these are real denials rather than a request in the prompt: the Slack MCP connectors (they post as whichever human authorised them, so the bot's reply arrives under someone else's name) and `aws logs` / `aws cloudwatch` (billed per GB; logs live in Grafana; the `cloudwatch` command is the one guarded path, see [CloudWatch](#cloudwatch)).

**Reacting** is granted to every role, including sandboxed ones, via `bin/slack-react.sh` - a helper that can only reach `reactions.add`. Sandboxed roles deliberately do *not* get a general `curl`: the bot's token is in the CLI's environment, so an arbitrary outbound request would be a way to send it somewhere.

## Dashboard

A **React 19 + Vite + React Router 7** single-page app (in `web/`, library-mode `react-router` package) served by the bot and backed by a JSON API under `/api`. It wears a Claude-style theme (ivory paper, clay accent, serif headings) in `web/src/styles.css`, light or dark. The theme button beside the sidebar toggle cycles system -> light -> dark (remembered per browser); "system" follows the OS live. Every colour is a CSS variable, so pages never hard-code one. Open `http://localhost:2001/` - it is loopback-only with no auth token (mutations still keep an automatic same-origin CSRF check). Tabs:

The sidebar collapses to a slim rail of icons, with each page's full name as the tooltip and accessible name (toggle button or Ctrl/Cmd+B, remembered per browser in `localStorage`); on a phone it is a top bar of text links and does not collapse.

- **Overview** - counts for users, conversations, stored turns, learnings, then an Activity section over the last 7/30/90 days (`GET /api/stats?days=`): messages per day, brain runs per day (chat and workflow turns, failures in the tooltip), list-price spend per day, the most-run commands, the most active people (turns plus commands) and how many threads were live today and this week. Hand-drawn SVG charts (no chart library), one series and one axis per chart, a hover tooltip on each, coloured only through the theme variables so dark mode just works. Days are the host's local days, and quiet days are drawn as zeros rather than skipped. Read from `messages`, `turn_log`, `llm_usage`, `command_log` and `thread_sessions` (`db/statsRepo.ts`); stored turns are cleared before a DB commit, so the messages chart only covers what is still stored
- **Users** - manage the allowlist: add someone by searching the workspace (name, @handle or Slack id - email too once `users:read.email` is granted) and picking them from a dropdown with avatar, name, display name and title, then a role; someone already on the list is marked and adding changes their role. The search is `GET /api/slack/members?q=`, filtered server-side over a `users.list` copy held in memory (every cursor page, deleted accounts and bots left out, refreshed at most every 10 minutes, the last good copy kept when a refresh fails). Pasting a raw `U…` id still works when the directory is unavailable. Then edit each person's Slack id, Slack name, GitHub logins (the `github_login:` links the review inbox and GitHub App use) and role inline. The owner's id and role are protected; their name and GitHub logins are editable
- **Roles** - the owner's page: tick the permissions each role grants (commands, GitHub App actions, tool tiers, MCP servers), set its rank and description, switch it on or off, create a role (optionally copying one), rename or delete one, choose the default role, name an MCP server, assign people to it, and edit the code-tier tool allow-list (see [Roles & tool access](#roles--tool-access)). The owner role is shown but locked
- **Memory** - with a memory adapter: propose one fact (it waits for the owner's approval like every learning written through the API, see below), edit any adapter file by hand (one whole file per save, checked by the same gate as `adapter refine` and kept as a revision; blank a file to remove it), or revert to an earlier revision. Without an adapter it is the flat **Learnings** list: edit one in place and save, or delete it
- **Identity** - edit the bot name, "thinking" label, and system prompt (persona), or reset the persona to default
- **Conversations** - browse the bot's own stored memory (SQLite), read turns, clear a channel. Both lists scroll instead of paging: the channel list loads the next page as you reach the bottom (`GET /api/conversations?cursor=`, cursor `<lastAt>:<channelId>`), and a conversation opens scrolled to its newest turn in reading order, loading older turns as you scroll up while keeping your place (`GET /api/conversation?channel=&before=<message id>`, 50 a page, `nextBefore` until the first turn). Every channel is shown as name and id (`#team-chat (C0TEAM00001)`, a DM as the person), and every person as name and id - never a bare Slack id, here, in the command log or on Spend. Names come from `conversations.info` / `users.info`, cached in the dashboard process (6 h, failures 10 min) so a page render does not call Slack per row; `conversations.info` needs the `*:read` scopes below
- **Architecture** - how the bot is built, as a system design walkthrough: an interactive diagram of every process, module and store, request flows you can play step by step (the diagram takes the full page width; play/back/next sit in a dock pinned to the bottom of the screen while the diagram is in view, with the current step as a caption - Space plays or pauses, the arrow keys step - and the step list and box inspector are under it) (a mention, a typed command, the brain running a command, a call from GitHub, a polled review run as the `review` command, a watch coming good, a restart that loses nothing), the layers, and the design decisions with their trade-offs. Under it, a static System design section in interview order: requirements, limits and numbers, the data model, the mention as a sequence diagram, deployment, and failure modes. Drawn from `web/src/systemModel.ts` and `web/src/systemDesign.ts`
- **Console** - a live Slack message manager (the web port of a terminal TUI): pick a channel/DM, read messages and threads, edit or delete the bot's own messages, reply, and generate an AI draft to review before posting. Requires extra Slack scopes (below); missing scopes surface as an in-app error.

Identity and learnings are stored in the DB and applied on the next reply - no restart.

**Learnings need the owner's approval.** A learning is injected into every future reply, in every channel, so only the owner typing `learn <fact>` saves one active. A `learn` from anyone else, a `learn` the agent runs for itself, and every `POST /api/learnings` (the endpoint the agent curls, and the dashboard's teach box - the loopback API cannot tell the two apart) is stored *pending*: it never reaches a prompt, the API answers `{"status":"pending", "id":N, "message":...}` so the agent does not claim it saved one, and the owner gets a DM with Approve / Reject buttons (or `learn pending`, `learn approve <id>`, `learn reject <id>`). Existing learnings stay active. Up to 20 can wait at once, and `POST /api/learnings/update` (new wording) sends the learning back to pending.

## Testing

```bash
bun test           # full suite (queues behind other full runs on this host, see below)
bun run typecheck  # tsc --noEmit
bun run test:e2e   # opt-in, real Slack: every e2e/*.e2e.ts (see below)
```

### One full run at a time per host

Several worktrees (bot turns, workers, `bin/jarvis-restart.sh`) running the whole suite at once can load a laptop past 20 and starve everything else. So a full `bun test` takes a host-wide lock first and lowers its own priority (`nice`); a second one waits its turn and says who holds the lock. This works for plain `bun test` too: `bunfig.toml` preloads `tests/support/hostLockPreload.ts`.

- Runs that name a file, directory or filter (`bun test path/x.test.ts`) are cheap and skip the lock. CI (`CI` set) skips it too.
- The lock is a file in `~/.cache/jarvis-test-lock`, outside the worktree so every worktree shares it. A holder that died (including a `--bail` stop, which leaves the file behind) is detected by its pid (and process start time) and its lock taken over.
- Env (read straight from the environment, not `src/config/env.ts`): `JARVIS_TEST_LOCK=0` turns it off, `JARVIS_TEST_LOCK_TIMEOUT_MS` (default 1800000) is how long to wait before giving up with exit 1, `JARVIS_TEST_NICE` (default 10), `JARVIS_TEST_LOCK_DIR`.

### End-to-end tests against real Slack (opt-in)

`bun run test:e2e` runs every file in `e2e/`. Each posts under its own root message in the test channel and deletes everything it posted:

| File | What it proves |
| --- | --- |
| `slackBlockKit.e2e.ts` | Block Kit replies (below) |
| `slackStream.e2e.ts` | the real `createSlackStream` over `chat.startStream`/`appendStream`/`stopStream`, text fed in small deltas, ends as ONE message with the full text, in the thread |
| `slackUpload.e2e.ts` | `bin/slack-upload.sh` (`files.getUploadURLExternal` + `files.completeUploadExternal` with `thread_ts`) lands the file in the thread, not at the channel root; the file is deleted afterwards |
| `slackWatch.e2e.ts` | a real `createWatcher` + `createShellCheck` + `watchRepo`: a watch stays quiet while its shell check exits non-zero, then fires once on exit 0 and hands back into the watched thread |

A new e2e file goes in `e2e/`, imports `./support.ts` (env gate, root message, cleanup) and is added to the `test:e2e` script; `*.e2e.ts` is not picked up by `bun test`, only by `test:e2e`, which CI runs in its own workflow (`e2e.yml`) on a push to `main` only.

`e2e/slackBlockKit.e2e.ts` drives a reply with Block Kit through the real stream code path (`createHandler` -> `createSlackStream` -> `chat.startStream`/`appendStream`/`stopStream`, the tidy-up rewrite and the plain-post fallbacks; only the model is scripted) and reads the thread back with `conversations.replies`. Per reply it asserts exactly one bot message, a `table` block where the reply had one, and no literal ```` ```blockkit ```` in the text or blocks. The cases: a table with an empty header cell (the bug that split a reply in two and lost the table), a plain-text reply, and a block Slack refuses (`alert`), which must degrade to its words.

It is not part of `bun test`: the file is not a `*.test.ts`, and it skips itself unless `JARVIS_E2E=1`, `SLACK_BOT_TOKEN` and `JARVIS_E2E_CHANNEL` are set. CI runs it in its own workflow (`.github/workflows/e2e.yml`) on a push to `main` only, with the bot token from the `JARVIS_E2E_SLACK_BOT_TOKEN` secret of the `e2e` GitHub environment, and fails when the secret is missing rather than letting the suite skip itself green. The token is an environment secret, never a repository secret: a repository secret reaches any workflow run from any branch, so anyone (or any app) that can push a branch could edit `ci.yml` there and send the token out. Set the environment's deployment branches to `main` only, and GitHub refuses the token to a run from any other branch or PR. Run it locally with the bot's token in the environment:

```bash
SLACK_BOT_TOKEN=xoxb-... JARVIS_E2E_CHANNEL=<channel id> bun run test:e2e
```

| Variable | Meaning |
| --- | --- |
| `SLACK_BOT_TOKEN` | the bot token; the bot must be a member of the channel |
| `JARVIS_E2E_CHANNEL` | channel id to post in; required, the suite skips itself without it (use a private test channel) |
| `JARVIS_E2E_USER` | Slack user id the streams are addressed to (default `OWNER_SLACK_ID` if set, else the bot's own id) |
| `JARVIS_E2E_KEEP` | `1` leaves what it posted in the channel instead of deleting it |

A run posts ONE root message (`jarvis e2e run <time>`) and every reply under it in the thread, then `chat.delete`s all of them, so the channel is left as it was. A run that is killed mid-way can leave its root behind: delete it by hand.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and the dashboard's typecheck and build (`web/`) on every PR and every push to `main`, and the e2e suite (secret `JARVIS_E2E_SLACK_BOT_TOKEN` on the `e2e` environment, deployment branches `main` only, plus repository variable `JARVIS_E2E_CHANNEL`) in its own workflow, `.github/workflows/e2e.yml`, on a push to `main` only. So a PR's e2e result shows after the merge, not before it, and a PR's checks have no e2e row at all (a cancelled one would read as red to `merge-when-green.sh`). The e2e workflow only runs in a repo that sets the `JARVIS_E2E_CHANNEL` variable, so forks and copies without a Slack workspace skip it; everything else still runs. A second job, `gitleaks`, scans the history on every push and the added commits on every PR, diffs plus commit messages, file paths and tag messages; known false positives (the RFC 6238 test vectors and a few fake tokens in tests) are allowlisted by value in `.gitleaks.toml`. To gate merges locally use `bin/merge-when-green.sh <pr>`, which waits for the checks, refuses unless they are all green, refuses at once (exit 4) when the PR conflicts with its base - GitHub runs no CI on it, so merge the base in and resolve first - and approves the PR as the merging account right before it merges (skipped when that account opened the PR, since GitHub forbids self-approval; a failed approval is no merge). With `SELF_PR_REVIEWER` set, run it as that account: `GH_TOKEN=$(gh auth token -u <reviewer>) bin/merge-when-green.sh <pr>`.

## Keeping private data out of the repo

This repo is public. GitHub secret scanning with push protection catches provider tokens; the leak guard adds project rules on top, using [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`):

- `.gitleaks.toml` extends the default rules with a Slack id rule (real-looking user, channel, DM, group, workspace, team, bot, app and enterprise, user group and file ids - `U`/`C`/`D`/`G`/`W`/`T`/`B`/`A`/`E`/`S`/`F`, legacy ids without the leading 0 included - are flagged, the obvious fakes used in tests such as `U0OWNER0001` are allowed). The company name is allowed.
- A second rule for real people and brand names is **not committed**, since listing the names would publish them. Copy `docs/leak-names.example.toml` to `~/.jarvis/leak-names.toml` (`chmod 600`) and fill it in. CI reads the same content from the `LEAK_NAMES_TOML` Actions secret, and fails when it is missing on a push or a same-repo PR (fork PRs get no secrets and skip the names rule). Locally, without the file the scan still runs and prints a notice.
- `bin/leak-scan.sh <gitleaks args>` runs gitleaks with the config plus the names file. Git scans read a merge commit's own changes (against its first parent) and files `.gitattributes` marks binary (`--text`). Every scan runs twice: with gitleaks' default rules, and with only these rules and no defaults, because the defaults' allowlist skips whole file types (svg, lockfiles, `.gitleaks.toml`). `gitleaks git` only reads diffs, so `bin/leak-scan.sh meta <gitleaks args>` scans the commit messages (an exact `Co-authored-by`/`Signed-off-by` trailer line is skipped as an identity) and file paths of `$LEAK_SCAN_RANGE`, the branch and tag names in `$LEAK_SCAN_REFS` and the names and messages of the tags in `$LEAK_SCAN_TAGS`. `bun run leak-scan` runs both over the history of `HEAD`.
- CI runs it on every pull request and on every push of any branch or tag, so a push that skipped the hook is still scanned. On a PR it also scans the title (`LEAK_SCAN_TEXT`), rechecked when the title is edited, since GitHub writes it into the merge commit on `main`. A push scans every public ref. The `checks` job installs gitleaks too, and the leak guard tests fail rather than skip under CI. The Actions log is public, so CI prints only the rule, commit and line of a hit (never a path or a ref name, which can hold the name that was caught), and `LEAK_SCAN_QUIET=true` withholds gitleaks' own output (a broken names regex would otherwise print the whole list). Known false positives are allowlisted by value in `.gitleaks.toml` (not by fingerprint, which a history rewrite breaks), and no file is exempt by path. A names source without a `[[rules]]` table carrying a `regex` counts as missing.
- Not scanned: commit author, committer and tagger names and emails, and `Co-authored-by`/`Signed-off-by` trailer lines. Nor UTF-16 or compressed files, tags of tags or refs outside branches and tags: nothing in this repo produces them, so the guard does not chase them. Contributors commit under their real identity, work address included, which is public by design on any git host.
- Local guard: run `bun run hooks` once per clone (it sets `core.hooksPath` to `.githooks`). The `pre-push` hook scans the commits being pushed (anything the target remote does not have yet, even if another remote does), their messages and file paths, the pushed branch or tag name and the name and message of a pushed annotated tag, and blocks the push with a message on a hit. It is skipped with a warning when gitleaks is not installed. Bypass in an emergency with `git push --no-verify`.

## Notes

- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
- The runtime database (`DATABASE_PATH`) holds this instance's identity/allowlist and lives outside the git checkout (see [Where the database lives](#where-the-database-lives)); `bin/db-backup.ts` is the backup. WAL sidecars are gitignored and flushed on clean shutdown.

## License

Apache License 2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Copyright 2026 Momos.
