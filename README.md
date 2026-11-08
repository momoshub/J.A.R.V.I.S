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
| `CLAUDE_CODE_OAUTH_TOKEN` | long-lived CLI auth from `claude setup-token`; without it the bot borrows the machine's interactive login and dies when that expires |
| `CLAUDE_BIN` / `CLAUDE_MODEL` | claude binary + model alias (claude-cli) |
| `CLAUDE_MODEL_PAL` | model for `pal` chat (default `haiku`) - see [Model per role](#model-per-role) |
| `CLAUDE_SKIP_PERMISSIONS` | `true` grants full tool access - see the security note (claude-cli) |
| `CLAUDE_CWD` | working dir for the CLI; blank = neutral temp dir outside this repo |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | required only when `LLM_PROVIDER=anthropic` |
| `BOT_NAME` | bootstrap bot name for a fresh DB (default `Assistant`) |
| `BOT_THINKING_LABEL` / `BOT_THINKING_DONE_LABEL` | bootstrap "thinking" step labels |
| `COMMAND_PREFIX` | message command trigger (default `//bot`; legacy `!` always works) |
| `SLASH_COMMAND` | Slack slash command to register (default `/bot`) |
| `OWNER_SLACK_ID` | the owner, cannot be removed |
| `DRAIN_NOTICE_CHANNEL` | channel for the one restart notice listing waiting threads (unset: silent) |
| `OFFLINE_ALARM_CHANNEL` | channel told when the host loses its connection, via a Slack scheduled message kept armed; a channel id, not a name (unset: no alarm) |
| `GITHUB_APP_ID` | GitHub App id (unset: `app.json` beside the private key) - see [Calling it from GitHub](#calling-it-from-github) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | app private key (default `~/.config/jarvis/github-app/private-key.pem`) |
| `GITHUB_APP_WEBHOOK_SECRET_PATH` / `GITHUB_APP_WEBHOOK_SECRET` | webhook secret file (default `~/.config/jarvis/github-app/webhook-secret`), or the value itself |
| `GITHUB_APP_PORT` | loopback port of the webhook listener (default `2003`) |
| `GITHUB_APP_SLUG` | app slug, `@<slug>` calls it (default `jarvis-at-acme`) |
| `GITHUB_APP_ALLOWED_OWNERS` | repo owners the app acts for, comma list (default `acme`) |
| `GITHUB_APP_LABEL` | label that calls it on an issue/PR (default `jarvis`) |
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
| `model [role\|here\|#channel] [name\|default]` | anyone (setting: admins) | show the brain; admins pin a model per role or channel |
| `logsource [grafana,datadog\|default]` | anyone (setting: admins) | where it looks for logs - see [Investigating](#investigating) |
| `forget` | anyone | wipe the bot's memory of this channel |
| `users` | admins | list the allowlist |
| `add @user [pal\|executer\|admin]` | admins (admin role: owner only) | grant access |
| `remove @user` | admins (admins: owner only) | revoke access |
| `learn <fact>` | admins | teach a durable fact |
| `learnings` / `relearn <id> <text>` / `unlearn <id>` | admins | list, reword or delete learnings |
| `review-policy [owner/repo] [first\|after\|default]` (alias `rvpolicy`) | anyone (setting: admins) | how a repo gets approved - see [Review policy per repo](#review-policy-per-repo) |
| `review-agents [n\|default]` (alias `rvagents`) | anyone (setting: admins) | how many child agents one review may fan out to - see [How wide a review fans out](#how-wide-a-review-fans-out) |
| `token [remove\|who]` (alias `claude-token`) | anyone | add, replace or forget your own Claude Code token - see [Your own Claude token](#your-own-claude-token) |
| `session [reset\|on\|off]` (alias `sess`) | anyone (on/off: admins) | the CLI session this thread is talking to - see [One session per thread](#one-session-per-thread) |
| `ticket <what is wrong>` (aliases `bug`, `raise`) | anyone | raise a properly written, correctly routed ticket - see [Raising a ticket](#raising-a-ticket) |
| `review <pr-url\|help\|prompt> [--policy first\|after] [what to look at]` (alias `rv`) | pal+ | review a PR: approve first (even if it is already merged or closed), then post the review as a GitHub comment *and* back in the thread; request changes on high risk (big PRs are cloned + reviewed by child agents). Runs full-access. |
| `bomb [categories] [count] <message-link>` (alias `br`) | admins | reaction-bomb a message. Combine categories with commas and set a count: `bomb money,face,negative 9 <link>`. Up to 23; `bomb help` lists every category |
| `reply <message-link>` (alias `jrp`) | admins | draft and post an AI reply to a message |
| `rm-msg <message-link>` (aliases `rmmsg`, `unsend`) | admins | delete a message the bot posted (a bot token cannot delete anyone else's) |
| `workflow <task>` / `workflow stop [<thread-link>]` / `workflow status` (alias `wf`) | executers+ | start a long task in this thread and keep talking to it (see [Workflows](#workflows)) |
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
  sandboxed workflow
- the session id is in the database, so a bot restart does not lose the session
- worker steps may run up to 15 minutes each; front answers are read-only and
  capped at 4 minutes
- an instruction reaches a running worker at its next step boundary, not mid-step

Because it lives in a thread, start it with the message form (`//bot workflow ...`)
rather than the slash command - a slash command has no thread to bind to.

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
2. **Datadog**, via the Datadog MCP tools, and only when Grafana genuinely has
   nothing - no such datasource, or the data does not reach back far enough. An
   empty result is an answer, not a reason to try the next one.

**CloudWatch is never queried.** It bills per GB scanned, so an idle look there
has an invoice attached. Sandboxed roles are denied `aws logs` and
`aws cloudwatch` outright; full-access roles are held to it by the prompt, since
nothing can be denied to them. If an answer only exists there, it says so and
lets a person decide.

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

## Investigating

```
//bot investigate why did /home crash for this user
```

`investigate` (aliases `inv`, `rca`) walks logs, RUM and traces for a cause and
reports back in the thread - it reads the thread first, so the ids and
timestamps already posted are not asked for again. It files nothing and changes
nothing unless you ask; finding out is the job.

It is a separate command for one reason: **Datadog is only reachable from the
host's login.** RUM - browser errors, user sessions, front-end crashes - exists
nowhere else, and the connectors that reach it come with the interactive
account session, not with a `claude setup-token` credential. Ordinary chat runs
on a setup token (the speaker's own, or the bot's), which loads zero `mcp__`
tools, so a chat turn can query Grafana through `gcx` and genuinely cannot see
Datadog however connected the account is. Chat does not hand that back to you,
though: when a question needs Datadog and the tools are not there, the bot runs
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

By default `review` approves immediately and reverses that with a request for
changes if the review turns up something blocking. Some repositories want the
opposite - nothing approved until a review has been written and come back clean:

```
//bot review-policy owner/repo after      approve only after a clean review
//bot review-policy owner/repo first      the default
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

Send anything while a turn is running and the busy notice carries the two things
a person sending a follow-up actually wants:

```
⏳ still working on *the escalation plans* (3m so far) - yours is next
   [ Stop that one ]  [ Never mind ]
```

- **Stop that one** kills the running turn. The CLI child is killed exactly as
  the timeout kills one, and the queued message then runs as normal.
- **Never mind** takes the message you just sent back off the queue, before it
  has spawned anything.

Only a message somebody typed gets the notice. A watch handing the thread back,
a workflow's next step or a followed thread queue the same way but silently,
since nobody is waiting on their place in line.
- Clicking neither still queues it, which is the old behaviour and the right
  default.

`//bot stop` does the same from a thread without needing a new message, which is
the case buttons cannot cover: a turn going wrong while you have nothing to add.

Your own turn is yours to stop. Stopping someone else's takes an admin, because
a turn is their work and - with per-user tokens - their money. A button that
outlived its run says so rather than failing: it sat in the channel while the
work finished on its own.

A stopped turn is **not** reported as a failure. It is killed the same way a
timeout kills one, so without care it would come back as "ran past my time
limit"; whoever stopped it already knows, and the thread has been told.

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
(default `data/tokens.key`). The database is committed like the main one; **the
key is gitignored**, so what lands in git is ciphertext and a copy taken from
anywhere but the host opens nothing.

## What a review comment looks like

One line saying where it lands, then the findings as bullets - one issue per
bullet, worst first, each saying what is wrong, where, and why it matters. No
summary of the diff, no overview, no headings.

It points at code rather than reproducing it: one short pointer per bullet, a
`file.ts:120` or an identifier, never both and never a code block, a diff hunk
or a line quoted back at the person who wrote it. The author has the code open;
what they need is the reasoning they cannot see.

It reads the description and the existing comments **before** reviewing, which
decides two things:

- **nothing already said gets said again** - not the diff summarised back, not a
  point another reviewer raised, not something the description already
  justifies. If the whole review would be known content, it says so in a line
  and stops
- **a declared gap is a warning, not a finding.** When the description or a
  comment says something is deliberately not handled here, it is not reviewed as
  a defect and never blocks. It gets one bullet at the end naming the risk left
  standing: *out of scope per the description: the retry path is unchanged, so a
  failed webhook still drops silently until the follow-up lands*

Scope covers what a PR does **not fix**, never what it **breaks**: if the change
itself introduces the problem, it is an ordinary finding however the description
frames it.

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
| `owner` | full control, cannot be removed |
| `admin` | full tool access (real shell, writes), manages users |
| `pal` | sandboxed read-only tools in a fixed scratch dir: GitHub read (`gh pr/issue/repo/run/release/api`, plus the GitHub MCP), Notion read (search/fetch/comments), web search + fetch, git/aws read-only. May use `review`, and may react |
| `executer` | sandboxed, tools assigned from the dashboard (Users -> Executer tools) |

Sandboxed roles run the Claude CLI without `--dangerously-skip-permissions`, with an explicit `--allowedTools` allow-list, so anything off the list is denied (verified: `pal` cannot write files). The `executer` allow-list is edited on the Users page.

Two more helpers are granted to every role for the same reason: `bin/slack-file.sh` (downloads a Slack attachment, and refuses any url that is not a Slack file) and `bin/jarvis-run.sh` (asks the bot to run one of its own commands, gated by the caller's role).

**Driving the desktop** goes through `bin/desktop.ts mac-ui|agent-desktop <args>`, which holds a desktop-wide lock per session (`JARVIS_DESKTOP_LOCK`, default `<tmpdir>/jarvis-desktop.lock`) so two threads never click into each other's windows. A busy screen exits 75; `desktop.ts free` exits 0 when the caller may act, `status` shows the holder, `release` gives it back. An idle lock lapses after 5 minutes.

Some tools are **denied to every role, full access included** - `--disallowedTools` is honoured alongside `--dangerously-skip-permissions`, so these are real denials rather than a request in the prompt: the Slack MCP connectors (they post as whichever human authorised them, so the bot's reply arrives under someone else's name) and `aws logs` / `aws cloudwatch` (billed per GB; logs live in Grafana).

**Reacting** is granted to every role, including sandboxed ones, via `bin/slack-react.sh` - a helper that can only reach `reactions.add`. Sandboxed roles deliberately do *not* get a general `curl`: the bot's token is in the CLI's environment, so an arbitrary outbound request would be a way to send it somewhere.

## Dashboard

A **React 19 + Vite + React Router 7** single-page app (in `web/`, library-mode `react-router` package) served by the bot and backed by a JSON API under `/api`. It wears a Claude-style theme (ivory paper, clay accent, serif headings) in `web/src/styles.css`, light by default and dark when the OS is - every colour is a CSS variable, so pages never hard-code one. Open `http://localhost:2001/` - it is loopback-only with no auth token (mutations still keep an automatic same-origin CSRF check). Tabs:

- **Overview** - counts for users, conversations, stored turns, learnings, and a tile into each area
- **Users** - manage the allowlist and roles (the owner is protected)
- **Memory** - with a memory adapter: teach one fact, edit any adapter file by hand (one whole file per save, checked by the same gate as `adapter refine` and kept as a revision; blank a file to remove it), or revert to an earlier revision. Without an adapter it is the flat **Learnings** list: edit one in place and save, or delete it
- **Identity** - edit the bot name, "thinking" label, and system prompt (persona), or reset the persona to default
- **Conversations** - browse the bot's own stored memory (SQLite), read turns, clear a channel
- **Architecture** - how the bot is built, as a system design walkthrough: an interactive diagram of every process, module and store, request flows you can play step by step (a mention, a typed command, the brain running a command, a call from GitHub, a polled review, a restart that loses nothing), the layers, and the design decisions with their trade-offs. Drawn from `web/src/systemModel.ts`
- **Console** - a live Slack message manager (the web port of a terminal TUI): pick a channel/DM, read messages and threads, edit or delete the bot's own messages, reply, and generate an AI draft to review before posting. Requires extra Slack scopes (below); missing scopes surface as an in-app error.

Identity and learnings are stored in the DB and applied on the next reply - no restart.

## Testing

```bash
bun test           # full suite
bun run typecheck  # tsc --noEmit
```

CI (`.github/workflows/ci.yml`) runs both, plus the dashboard's typecheck and build (`web/`), on every PR and every push to `main`. The repo is private on a free plan, so GitHub cannot require it before a merge: merge with `bin/merge-when-green.sh <pr>`, which waits for the checks and refuses unless they are all green.

## Notes

- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
- The runtime database (`data/ev.db`) is committed and holds this instance's identity/allowlist. Conversation content is not committed (the messages table is cleared before commit). WAL sidecars are gitignored and flushed on clean shutdown.
