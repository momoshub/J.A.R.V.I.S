# Slack Agent Bot

A configurable Slack agent bot. Its "brain" is your local **Claude Code CLI** (with full tool access) or the **Anthropic API**. It has SQLite memory, an allowlist, live streaming replies with a tool-call timeline, and an admin dashboard.

The codebase is generic - the bot's identity (name, persona, labels) lives in the database and is edited from the dashboard, so the same code runs any bot. `data/ev.db` is a leftover example instance ("Evie") that nothing reads.

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
| `CLAUDE_CODE_OAUTH_TOKEN` | long-lived CLI auth from `claude setup-token`; without it the bot borrows the machine's interactive login and dies when that expires |
| `CLAUDE_BIN` / `CLAUDE_MODEL` | claude binary + model alias (claude-cli) |
| `CLAUDE_MODEL_PAL` | model for `pal` chat (default `haiku`) - see [Model per role](#model-per-role) |
| `CLAUDE_SKIP_PERMISSIONS` | `true` grants full tool access - see the security note (claude-cli) |
| `CLAUDE_CWD` | working dir for the CLI; blank = neutral temp dir outside this repo |
| `ORCA_TERMINAL_WORKTREE` | Orca worktree selector the bot opens its own terminal in, handed to every turn as `ORCA_TERMINAL_HANDLE` so it can run `orca orchestration` (default `path:~/Workspaces`; `off` disables). Orca not running = no handle, turns fall back to the Agent tool. A question one of those workers asks (`orca orchestration ask`) is put to the Slack thread that started it as a turn, which answers it with `orca orchestration reply` - see [Orca workers' questions](#orca-workers-questions) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | required only when `LLM_PROVIDER=anthropic` |
| `BOT_NAME` | bootstrap bot name for a fresh DB (default `Assistant`) |
| `BOT_THINKING_LABEL` / `BOT_THINKING_DONE_LABEL` | bootstrap "thinking" step labels |
| `COMMAND_PREFIX` | message command trigger (default `//bot`; legacy `!` always works) |
| `SLASH_COMMAND` | Slack slash command to register (default `/bot`) |
| `OWNER_SLACK_ID` | the owner, cannot be removed |
| `RESTART_TURN_BUDGET_MS` | while a restart waits, new messages still run, each turn on this budget (default `120000`); past it the thread is told to hold on and the turn is cut, then picked up again on the same session after the restart |
| `DRAIN_NOTICE_CHANNEL` | channel for the one restart notice listing waiting threads (unset: silent); also where the inner child logs voice drift unless `inner_child_drift_channel` is set, and where a press on Slack's stop button is reported (the stopped thread is not told) |
| `OFFLINE_ALARM_CHANNEL` | channel told when the host loses its connection, via a Slack scheduled message kept armed; a channel id, not a name (unset: no alarm) |
| `GITHUB_APP_ID` | GitHub App id (unset: `app.json` beside the private key) - see [Calling it from GitHub](#calling-it-from-github) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | app private key (default `~/.config/jarvis/github-app/private-key.pem`) |
| `GITHUB_APP_WEBHOOK_SECRET_PATH` / `GITHUB_APP_WEBHOOK_SECRET` | webhook secret file (default `~/.config/jarvis/github-app/webhook-secret`), or the value itself |
| `GITHUB_APP_PORT` | loopback port of the webhook listener (default `2003`) |
| `GITHUB_APP_SLUG` | app slug, `@<slug>` calls it (default `jarvis-at-acme`) |
| `GITHUB_APP_ALLOWED_OWNERS` | repo owners the app acts for, comma list (default `acme`) |
| `GITHUB_APP_LABEL` | label that calls it on an issue/PR (default `jarvis`) |
| `SELF_PR_AUTHOR` / `SELF_PR_REVIEWER` | gh logins for the bot's own PRs: the author opens the PR and answers reviews, the reviewer posts review comments, approves and merges. Both or neither, and not the same login (otherwise: one account) |
| `DASHBOARD_PORT` | dashboard port (local, loopback-only, no auth) |
| `DASHBOARD_ALLOWED_ORIGINS` | extra browser origins allowed to POST (proxy/tunnel access) |
| `DATABASE_PATH` | the live sqlite file (default `data/bot.db`). Put it **outside the git checkout**, `~/` works, e.g. `~/.jarvis/data/bot.db` - see [Where the database lives](#where-the-database-lives) |
| `DATABASE_MIGRATE_FROM` | one-time move: when `DATABASE_PATH` does not exist and this file does, the first boot fills it with a consistent snapshot of this one (the old file is only read). Unset: nothing |
| `TOKEN_DATABASE_PATH` / `TOKEN_DATABASE_MIGRATE_FROM` | the same pair for the token database (default `data/tokens.db`) |
| `DATABASE_BACKUP_DIR` | where `bin/db-backup.ts` writes snapshots (default `~/.jarvis/backups`) |

Env values for identity only **bootstrap a fresh database**. Once set, the DB values (edited from the dashboard) take precedence, so the code stays generic.

### Where the database lives

The live SQLite files must not sit in the git checkout: a `git stash`, `checkout`, `reset` or `rebase` there replaces the file under the open handle and the bot dies with a SQLite disk I/O error. Point `DATABASE_PATH` and `TOKEN_DATABASE_PATH` at a folder outside the repo (`~/.jarvis/data/`). To move an existing instance without copying by hand, also set `DATABASE_MIGRATE_FROM=data/<old>.db` (and `TOKEN_DATABASE_MIGRATE_FROM=data/tokens.db`): on boot, a missing (or 0-byte / table-less) destination is filled once with a consistent snapshot of the old file (`VACUUM INTO`, so the WAL is included and a running writer is fine). A relative source resolves against the checkout, not the working directory, and the resolved `to`/`from` are logged on every boot. If the source is configured but missing, the bot refuses to start rather than create an empty database. A destination that has tables is never touched, so the lines can stay in `.env`. The old file is only read, never changed or deleted.

Backups: `bun bin/db-backup.ts [--keep N] [--commit]` writes a consistent snapshot of both databases to `DATABASE_BACKUP_DIR` (default `~/.jarvis/backups`, `<name>-<UTC stamp>.db`, newest 14 kept per database). To keep the old "the database is in git" property, make that folder a private git repository of its own and use `--commit`: the history lives in git, and the live file never does. Run it from cron or launchd, e.g. every 6 hours: `0 */6 * * * cd /path/to/repo && bun bin/db-backup.ts --commit`. The token database is ciphertext; its key (`TOKEN_KEY_PATH`) is not backed up, so keep a copy of it somewhere safe.

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
- **It opens what you share.** Links in a message (or earlier in the thread) are fetched before it answers, and attachments - screenshots, logs, documents - are downloaded and read. It will not ask you to paste something it could have opened, and if something genuinely cannot be read it says so rather than answering around it

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
| `model [role\|subagent\|worker\|plan\|here\|#channel] [name\|default]` | anyone (setting: admins) | show the brain; admins pin a model per role or channel, or for subagents, Orca workers and planning |
| `logsource [grafana,datadog\|default]` | anyone (setting: admins) | where it looks for logs - see [Investigating](#investigating) |
| `cloudwatch [--group /log/group] [--last 15m \| --from <t> --to <t>] [--region r] [--limit n] <insights query>` (alias `cw`), `cloudwatch help`, `cloudwatch default <group\|reset>` | executer and up (owner runs it directly, executer and admin confirm first) | query CloudWatch Logs Insights directly - see [CloudWatch](#cloudwatch) |
| `forget` | anyone | wipe the bot's memory of this channel |
| `sys` (alias `vitals`) | admins | how the host, the bot and Orca are doing, as Block Kit: a verdict header, cpu/memory/swap/disk/host/bot/turns fields, the last hour's trend, then Orca's runtime, active runs, workers by status and a table of live workers (one "unreachable" line when Orca is down or slow). The message text keeps the plain report as the fallback |
| `users` | admins | list the allowlist |
| `worker-cost <ctx_...\|run_...>` (alias `wcost`) | admins | tokens and list-price cost of an Orca worker, or every worker in a Run - see [What an Orca worker cost](#what-an-orca-worker-cost) |
| `add @user [pal\|executer\|admin]` | admins (admin role: owner only) | grant access |
| `remove @user` | admins (admins: owner only) | revoke access |
| `learn <fact>` | admins | teach a durable fact |
| `learnings` / `relearn <id> <text>` / `unlearn <id>` | admins | list, reword or delete learnings |
| `review-policy [owner/repo] [first\|after\|default]` (alias `rvpolicy`) | anyone (setting: admins) | how a repo gets approved - see [Review policy per repo](#review-policy-per-repo) |
| `review-agents [n\|default]` (alias `rvagents`) | anyone (setting: admins) | how many child agents one review may fan out to - see [How wide a review fans out](#how-wide-a-review-fans-out) |
| `token [remove\|who]` (alias `claude-token`) | anyone | add, replace or forget your own Claude Code token - see [Your own Claude token](#your-own-claude-token) |
| `session [reset\|on\|off]` (alias `sess`) | anyone (on/off: admins) | the CLI session this thread is talking to - see [One session per thread](#one-session-per-thread) |
| `ticket <what is wrong>` (aliases `bug`, `raise`) | anyone | raise a properly written, correctly routed ticket - see [Raising a ticket](#raising-a-ticket) |
| `review <pr-url\|help\|prompt> [--policy first\|after] [what to look at]` (alias `rv`) | pal+ | review a PR: read it first, post a blockers-only comment on GitHub *and* back in the thread (PRs in `acme` repos also get the non-blocking findings as bullets); request changes on a blocker only, other repos drop non-blocking findings (big PRs are cloned + reviewed by child agents). Runs full-access. |
| `bomb [categories] [count] <message-link>` (alias `br`) | admins | reaction-bomb a message. Combine categories with commas and set a count: `bomb money,face,negative 9 <link>`. Up to 23; `bomb help` lists every category |
| `reply <message-link>` (alias `jrp`) | admins | draft and post an AI reply to a message |
| `rm-msg <message-link>` (aliases `rmmsg`, `unsend`) | admins | delete a message the bot posted (a bot token cannot delete anyone else's) |
| `workflow <task>` / `workflow stop [<thread-link>]` / `workflow status` (alias `wf`) | executers+ | start a long task in this thread and keep talking to it (see [Workflows](#workflows)) |
| `limit [@user] [n\|default]` (alias `quota`) | anyone (setting: admins) | show command allowance; admins set someone's |
| `mindful [hours]` / `mindful continue\|reply <thread-link>` (aliases `mind`, `whatsup`) | admins | everything it is doing: stuck turns (a failed last turn; one a person stopped is not stuck), Orca tasks whose worker is gone and quiet PRs on its own repo (each with the thread that started it), what is running and waiting, and what it cost - see [Stuck work](#stuck-work) |
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
identically. Preset tasks that force a policy keep their own model: `review`
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

```
//bot model                     also lists these three
//bot model worker haiku        pin one
//bot model plan default        back to its default
```

Read per turn, so no restart. Subagents get `CLAUDE_CODE_SUBAGENT_MODEL`, and the
built-in Explore and Plan agents are replaced through `--agents` with the same
job and a pinned model, because both inherit the turn's model and ignore that
variable. Workers get it through `BOT_WORKER_MODEL`, which the prompts pass to
`orca ... --model`.

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
comments). Unverified until set up on the host: unlike the local database servers this is a remote OAuth server, so check with `claude mcp list` and a real call from a chat turn that it loads under the setup token; if it does not, the prompt falls back to `read`/`note`. It writes as the host's Notion identity, so it follows `note`'s floor:
`note access <role>` (default admin). Other connectors are not widened.

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

By default `review` posts "reviewing", runs the review, and approves only once
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

Policies are configuration, in the database: no repository is named anywhere in
this codebase, which matters because it is open.

One run can ask for a different policy without changing anything:

```
//bot review <pr-url> --policy after     hold the approval back, this run only
//bot review <pr-url> --policy first     approve up front, this run only
//bot review <pr-url> --policy default   the built-in default, this run only
//bot review <pr-url> --after            the same, shorter
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
and open PRs on its own repo with no commit, comment or review for 30 minutes.
It DMs the owner (`OWNER_SLACK_ID`) one short message listing what is new, each
with the Slack thread whose turn started it, and does not repeat an item for 4
hours - a restart does not reset that. When Orca or `gh` cannot be asked it
says nothing rather than claim all is well; `mindful` shows the same lists on
demand, with a "could not check" line when that happens.

## How the brain runs a command

The brain can run the bot's own commands for whoever it is talking to. It never
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
(owner/admin) and sandboxed (pal/executer) roles run the CLI in different
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
(`@jarvis-at-acme why does this fail?`), or add the `jarvis` label to an issue
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

For anything wider, an **admin or the owner** can have a turn act as the app on
any repository it is installed on (`acme`, `cute-me-on-repos`, ...):

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
committed by `jarvis-at-acme[bot]` (`<id>+jarvis-at-acme[bot]@users.noreply.github.com`,
no GPG signing; the id is looked up once with `GET /users/<slug>[bot]`), and
anything that talks to github.com (fetch, pull, push, ls-remote; an ssh remote
is read as https) carries a fresh installation token. `push` pushes one branch
to the remote of `<dir>` that points at `<owner/repo>`. The token is a one-shot
credential: the bot hands it back for the `git-auth` action (same ticket, same
admin/owner gate, same command log row, no token in the log) and the helper puts
it in that one git process's environment as `http.extraheader` through
`GIT_CONFIG_*` - never in a remote url, `.git/config`, argv or any file. A
cherry-picked commit keeps its original author unless you pass `--reset-author`.

```
bin/github-app.sh git acme/acme-be ~/Workspaces/be -- commit -m "fix: x"
bin/github-app.sh push acme/acme-be ~/Workspaces/be fix/x
```

In the `acme` org, every PR is committed and opened as the app
(`git` + `push` + `pr-create` above); review comments and the merge are done as
`kai-at-acme`.

It only acts on owners in `GITHUB_APP_ALLOWED_OWNERS`. It posts to `/api/github-app/action` with the turn's ticket (from
`JARVIS_RUN_TICKET`, never an argument); the bot resolves it to the person the
turn runs as, refuses unless they are admin or owner, logs the call in the
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

`@bot review <pr-url>` runs the review command, the same as typing it with the
prefix. It has to be a mention carrying a real pull request url and actually say
"review" - anything vaguer stays a conversation, because a review spends the
asker's own credential rather than being free.

This matters beyond convenience: only the command can offer the box that takes a
Claude token, so a spoken request used to get a description of the token instead
of the button that accepts one.

Flags carry through (`@bot review <url> --policy after`); the rest of the
sentence does not. "can you please" is not guidance, and guessing which half of
a sentence was meant as an instruction is worse than not trying - typed with the
prefix, the free text is the steering note.

## Your own Claude token

`review` runs the Claude Code CLI, and the CLI bills whoever's token it is
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
never set up. Only `review` insists.

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

## What a review comment looks like

Blockers only (outside `acme` repos, see below). One line saying where it lands - good to merge, or what blocks -
then one short bullet per blocker, worst first: what is wrong, one pointer
(`file.ts:120` or an identifier, never a code block or a quoted line), why it
matters. A clean PR gets that one line and the sign-off.

Blocking means a security hole, data loss, a breaking change, a correctness bug
that would ship, missing or failing tests on a critical path, or failing CI.
Everything else - design, cleanups, style, nits - is never posted, and never
becomes a GitHub issue either: it is dropped.

PRs in acme repos (GitHub owner `acme`, decided per PR url) are the
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

`review help` describes the flow in a few lines; `review prompt` prints the
actual system prompt it runs on, which is no secret - it is in this repository.

Both exist because the question used to cost a review: asked to explain itself,
the bot ran `review help`, took the word "help" as a target, and spent minutes
reviewing a pull request by that name on the asker's own credential. An argument
now has to look like a pull request - a url, `owner/repo#123`, or a bare number -
before anything expensive starts.

## Steering a review

Anything typed next to the url is guidance, not a second target:

```
//bot review <pr-url> the migration is the risky bit
//bot review <pr-url> hotfix, only care about data loss on the delete path
//bot review <pr-url> check it against GEN-1234
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
| `owner` | full control, cannot be removed. The only role that may run `orca` |
| `admin` | full tool access (real shell, writes), manages users. No `orca`: it is denied by name, background work goes through the Agent tool |
| `pal` | sandboxed read-only tools in a fixed scratch dir: GitHub read (`gh pr/issue/repo/run/release/api`, plus the GitHub MCP), Notion read (search/fetch/comments), web search + fetch, git/aws read-only. May use `review`, and may react |
| `executer` | sandboxed, tools assigned from the dashboard (Roles -> Executer tools), plus - always, in code - the read-only databases, the code tools (clone into the scratch dir, edit, commit, push a branch, open a PR) and the `Agent`/`Task` tool for parallel or long work in its own process. No `orca` |

Sandboxed roles run the Claude CLI without `--dangerously-skip-permissions`, with an explicit `--allowedTools` allow-list. The `executer` allow-list is edited on the Roles page.

**Orca is owner-only.** An Orca worker runs with full permissions on the host Mac, so a role that could start one would step out of its own sandbox. `Bash(orca:*)` (and the installed paths, `ORCA_DENY` in `src/domain/toolPolicy.ts`) is in `--disallowedTools` for `pal`, `executer` and `admin`, because an allow-list never refuses - only a denial does. An `executer` still gets a code job done inside its own sandboxed CLI process: it clones into the scratch dir, edits, commits, pushes and opens the PR, and uses the Agent tool (foreground, or `run_in_background`) for parallel or long work - a subagent inherits the same sandboxed permissions, so nothing is escaped. `Agent` and `Task` are in `EXECUTER_CODE_TOOLS`, so they do not depend on the dashboard tool list (which replaces the defaults when it is not empty). The prompt follows the role: owner turns keep the Orca wording (workers, `watch worker`, the Orca reviewer for a self-fix), every other role is told to use the Agent tool and never to call `orca`, in chat and in a workflow. Preset commands run under the bot's own owner policy, so they are untouched: `fanout` (admin+) still starts Orca workers itself, and the bot's own reads (`sys`, `worker-cost`, `stop`, the stuck-work sweeper, worker questions) still call `orca`. Limit: the denial matches the command as typed, so a wrapper such as `bash -c "orca ..."` or an unlisted install path is not caught.

**Role policies** (dashboard -> Roles, stored in `role_policies`): each role can be switched off, and can be denied commands, CLI tools and whole MCP servers on top of what the code already denies it. A policy only takes away - the most a role may do (a command's minimum role, the sandbox deny lists) stays fixed in code, so the Roles page lists only the commands within a role's rank. A switched-off role grants nothing: its members are treated as not on the allowlist everywhere (chat, commands, buttons, GitHub calls) and are told their role is off instead of being raised as an access request. Their pending watches stop too (a watch predicate is shell run as the bot). Admins still see and manage them from Slack (`users` marks them, `remove`/`add`/`promote`/`demote` act on their real record). Denied tools and servers go into `--disallowedTools` for every turn of that role, full-access roles included; denied commands are refused at dispatch and left out of `help`. The owner role is always on and never restricted, whatever is saved. Saves apply to the next message, no restart. Preset full-access tasks (`review`, `investigate`, `ticket`, ...) keep their own fixed tool policy; deny the command itself to keep a role away from one.

Two more helpers are granted to every role for the same reason: `bin/slack-file.sh` (downloads a Slack attachment, and refuses any url that is not a Slack file) and `bin/jarvis-run.sh` (asks the bot to run one of its own commands, gated by the caller's role).

**Driving the desktop** goes through `bin/desktop.ts mac-ui|agent-desktop <args>`, which holds a desktop-wide lock per session (`JARVIS_DESKTOP_LOCK`, default `<tmpdir>/jarvis-desktop.lock`) so two threads never click into each other's windows. A busy screen exits 75; `desktop.ts free` exits 0 when the caller may act, `status` shows the holder, `release` gives it back. An idle lock lapses after 5 minutes.

Some tools are **denied to every role, full access included** - `--disallowedTools` is honoured alongside `--dangerously-skip-permissions`, so these are real denials rather than a request in the prompt: the Slack MCP connectors (they post as whichever human authorised them, so the bot's reply arrives under someone else's name) and `aws logs` / `aws cloudwatch` (billed per GB; logs live in Grafana; the `cloudwatch` command is the one guarded path, see [CloudWatch](#cloudwatch)).

**Reacting** is granted to every role, including sandboxed ones, via `bin/slack-react.sh` - a helper that can only reach `reactions.add`. Sandboxed roles deliberately do *not* get a general `curl`: the bot's token is in the CLI's environment, so an arbitrary outbound request would be a way to send it somewhere.

## Dashboard

A **React 19 + Vite + React Router 7** single-page app (in `web/`, library-mode `react-router` package) served by the bot and backed by a JSON API under `/api`. It wears a Claude-style theme (ivory paper, clay accent, serif headings) in `web/src/styles.css`, light or dark. The theme button beside the sidebar toggle cycles system -> light -> dark (remembered per browser); "system" follows the OS live. Every colour is a CSS variable, so pages never hard-code one. Open `http://localhost:2001/` - it is loopback-only with no auth token (mutations still keep an automatic same-origin CSRF check). Tabs:

The sidebar collapses to a slim rail of icons, with each page's full name as the tooltip and accessible name (toggle button or Ctrl/Cmd+B, remembered per browser in `localStorage`); on a phone it is a top bar of text links and does not collapse.

- **Overview** - counts for users, conversations, stored turns, learnings, then an Activity section over the last 7/30/90 days (`GET /api/stats?days=`): messages per day, brain runs per day (chat and workflow turns, failures in the tooltip), list-price spend per day, the most-run commands, the most active people (turns plus commands) and how many threads were live today and this week. Hand-drawn SVG charts (no chart library), one series and one axis per chart, a hover tooltip on each, coloured only through the theme variables so dark mode just works. Days are the host's local days, and quiet days are drawn as zeros rather than skipped. Read from `messages`, `turn_log`, `llm_usage`, `command_log` and `thread_sessions` (`db/statsRepo.ts`); stored turns are cleared before a DB commit, so the messages chart only covers what is still stored
- **Users** - manage the allowlist: add someone by searching the workspace (name, @handle or Slack id - email too once `users:read.email` is granted) and picking them from a dropdown with avatar, name, display name and title, then a role; someone already on the list is marked and adding changes their role. The search is `GET /api/slack/members?q=`, filtered server-side over a `users.list` copy held in memory (every cursor page, deleted accounts and bots left out, refreshed at most every 10 minutes, the last good copy kept when a refresh fails). Pasting a raw `U…` id still works when the directory is unavailable. Then edit each person's Slack id, Slack name, GitHub logins (the `github_login:` links the review inbox and GitHub App use) and role inline. The owner's id and role are protected; their name and GitHub logins are editable
- **Roles** - switch each role on or off, untick the commands, tools and MCP servers it may not use, assign people to it, and edit the executer tool allow-list (see [Roles & tool access](#roles--tool-access)). The owner role is shown but locked
- **Memory** - with a memory adapter: teach one fact, edit any adapter file by hand (one whole file per save, checked by the same gate as `adapter refine` and kept as a revision; blank a file to remove it), or revert to an earlier revision. Without an adapter it is the flat **Learnings** list: edit one in place and save, or delete it
- **Identity** - edit the bot name, "thinking" label, and system prompt (persona), or reset the persona to default
- **Conversations** - browse the bot's own stored memory (SQLite), read turns, clear a channel. Both lists scroll instead of paging: the channel list loads the next page as you reach the bottom (`GET /api/conversations?cursor=`, cursor `<lastAt>:<channelId>`), and a conversation opens scrolled to its newest turn in reading order, loading older turns as you scroll up while keeping your place (`GET /api/conversation?channel=&before=<message id>`, 50 a page, `nextBefore` until the first turn). Every channel is shown as name and id (`#team-chat (C0TEAM00001)`, a DM as the person), and every person as name and id - never a bare Slack id, here, in the command log or on Spend. Names come from `conversations.info` / `users.info`, cached in the dashboard process (6 h, failures 10 min) so a page render does not call Slack per row; `conversations.info` needs the `*:read` scopes below
- **Architecture** - how the bot is built, as a system design walkthrough: an interactive diagram of every process, module and store, request flows you can play step by step (the diagram takes the full page width; play/back/next sit in a dock pinned to the bottom of the screen while the diagram is in view, with the current step as a caption - Space plays or pauses, the arrow keys step - and the step list and box inspector are under it) (a mention, a typed command, the brain running a command, a call from GitHub, a polled review run as the `review` command, a watch coming good, a restart that loses nothing), the layers, and the design decisions with their trade-offs. Under it, a static System design section in interview order: requirements, limits and numbers, the data model, the mention as a sequence diagram, deployment, and failure modes. Drawn from `web/src/systemModel.ts` and `web/src/systemDesign.ts`
- **Console** - a live Slack message manager (the web port of a terminal TUI): pick a channel/DM, read messages and threads, edit or delete the bot's own messages, reply, and generate an AI draft to review before posting. Requires extra Slack scopes (below); missing scopes surface as an in-app error.

Identity and learnings are stored in the DB and applied on the next reply - no restart.

## Testing

```bash
bun test           # full suite
bun run typecheck  # tsc --noEmit
bun run test:e2e   # opt-in, real Slack: every e2e/*.e2e.ts (see below)
```

### End-to-end tests against real Slack (opt-in)

`bun run test:e2e` runs every file in `e2e/`. Each posts under its own root message in the test channel and deletes everything it posted:

| File | What it proves |
| --- | --- |
| `slackBlockKit.e2e.ts` | Block Kit replies (below) |
| `slackStream.e2e.ts` | the real `createSlackStream` over `chat.startStream`/`appendStream`/`stopStream`, text fed in small deltas, ends as ONE message with the full text, in the thread |
| `slackUpload.e2e.ts` | `bin/slack-upload.sh` (`files.getUploadURLExternal` + `files.completeUploadExternal` with `thread_ts`) lands the file in the thread, not at the channel root; the file is deleted afterwards |
| `slackWatch.e2e.ts` | a real `createWatcher` + `createShellCheck` + `watchRepo`: a watch stays quiet while its shell check exits non-zero, then fires once on exit 0 and hands back into the watched thread |

A new e2e file goes in `e2e/`, imports `./support.ts` (env gate, root message, cleanup) and is added to the `test:e2e` script; `*.e2e.ts` is not picked up by `bun test`, only by `test:e2e`, which CI runs as its own step.

`e2e/slackBlockKit.e2e.ts` drives a reply with Block Kit through the real stream code path (`createHandler` -> `createSlackStream` -> `chat.startStream`/`appendStream`/`stopStream`, the tidy-up rewrite and the plain-post fallbacks; only the model is scripted) and reads the thread back with `conversations.replies`. Per reply it asserts exactly one bot message, a `table` block where the reply had one, and no literal ```` ```blockkit ```` in the text or blocks. The cases: a table with an empty header cell (the bug that split a reply in two and lost the table), a plain-text reply, and a block Slack refuses (`alert`), which must degrade to its words.

It is not part of `bun test`: the file is not a `*.test.ts`, and it skips itself unless `JARVIS_E2E=1` and `SLACK_BOT_TOKEN` are set. CI runs it as its own step with the bot token from the `JARVIS_E2E_SLACK_BOT_TOKEN` repo secret, and fails that step when the secret is missing rather than letting the suite skip itself green. Run it locally with the bot's token in the environment:

```bash
SLACK_BOT_TOKEN=xoxb-... bun run test:e2e
```

| Variable | Meaning |
| --- | --- |
| `SLACK_BOT_TOKEN` | the bot token; the bot must be a member of the channel |
| `JARVIS_E2E_CHANNEL` | channel to post in (default `C0TEST00005`, the private `#jarvis_self_testing`) |
| `JARVIS_E2E_USER` | Slack user id the streams are addressed to (default `OWNER_SLACK_ID` if set, else the bot's own id) |
| `JARVIS_E2E_KEEP` | `1` leaves what it posted in the channel instead of deleting it |

A run posts ONE root message (`jarvis e2e run <time>`) and every reply under it in the thread, then `chat.delete`s all of them, so the channel is left as it was. A run that is killed mid-way can leave its root behind: delete it by hand.

CI (`.github/workflows/ci.yml`) runs both, the e2e suite, plus the dashboard's typecheck and build (`web/`), on every PR and every push to `main`. The repo is private on a free plan, so GitHub cannot require it before a merge: merge with `bin/merge-when-green.sh <pr>`, which waits for the checks, refuses unless they are all green, refuses at once (exit 4) when the PR conflicts with its base - GitHub runs no CI on it, so merge the base in and resolve first - and approves the PR as the merging account right before it merges (skipped when that account opened the PR, since GitHub forbids self-approval; a failed approval is no merge). With `SELF_PR_REVIEWER` set, run it as that account: `GH_TOKEN=$(gh auth token -u <reviewer>) bin/merge-when-green.sh <pr>`.

## Notes

- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
- The runtime database (`DATABASE_PATH`) holds this instance's identity/allowlist and lives outside the git checkout (see [Where the database lives](#where-the-database-lives)); `bin/db-backup.ts` is the backup. WAL sidecars are gitignored and flushed on clean shutdown.
