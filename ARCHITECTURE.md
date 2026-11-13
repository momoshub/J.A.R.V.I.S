# Architecture

The bot runs as two processes on one host, a Slack gateway and the bot itself,
joined by a SQLite inbox. Inside the bot the code follows a clean, layered
architecture: dependencies point inward, outer layers know about inner ones,
never the reverse. Every layer is functional - factories and pure functions,
no classes.

## Runtime

```
      Slack (Socket Mode)                          GitHub
            |   ^                                    ^ |
  envelopes |   | replies (Web API, chat.startStream)| | review requests (polled)
            |   |                                    | | App webhook (Funnel ->
            |   |                                    | | 127.0.0.1:2003)
            v   |                                    |
  +-----------------+                                |
  | src/gateway.ts  |  holds the socket, never       |
  | (own supervisor)|  restarts                      |
  +-----------------+                                |
            |                                        |
            v                                        |
       INBOX_DATABASE_PATH (SQLite queue)      |
            |                                        |
  +---------v--------------------------------------------------------------+
  | src/index.ts - the bot (SLACK_TRANSPORT=inbox)                          |
  |                                                                         |
  |  inboxReceiver -> Bolt app.ts -> respond -+-> commands (role gate,      |
  |                                           |     allowance, audit log)   |
  |                                           +-> handleMessage (chat)      |
  |                                                    |                    |
  |                    threadQueue (1 turn per thread) + runRegistry (stop) |
  |                                                    |                    |
  |                    LlmPort: claude CLI, one --resume session per thread |
  |                    tool policy per role, stream.ts -> live Slack reply  |
  |                                                                         |
  |  timers, outside every turn:                                            |
  |    watcher | reminders | loops | reviewInbox | workflow continues | ...  |
  |    orcaQuestions (worker questions -> the thread that started it)      |
  |    offlineAlarm (keeps an "I'm offline" Slack scheduled msg armed)     |
  |    stuckSweeper (dead Orca workers, quiet own PRs -> owner DM, 15 min)  |
  |                                                                         |
  |  dashboard + JSON API (Bun.serve, loopback), /api/commands/run,         |
  |    /api/github-app/comment                                              |
  |  GitHub App webhook listener (loopback, own port) -> githubApp          |
  +-------------------------------------------------------------------------+
            |                                   |
            v                                   v
   DATABASE_PATH, TOKEN_DATABASE_PATH    bin/ helpers the brain calls
   (outside the checkout, ~/.jarvis),   (slack-read, slack-react, run, ...)
   data/adapter-mirror/ (from DB),      bin/db-backup.ts -> DATABASE_BACKUP_DIR
   data/prompt-guides/ (from code)
```

- **The live databases are outside git.** `DATABASE_PATH` and
  `TOKEN_DATABASE_PATH` point outside the checkout, because a git operation that
  replaces a file under an open SQLite handle crashes the bot. A path may be moved
  once with `DATABASE_MIGRATE_FROM` / `TOKEN_DATABASE_MIGRATE_FROM`:
  `adoptDatabase` (`infrastructure/db/location.ts`) fills a missing (or empty) destination
  with a `VACUUM INTO` snapshot at boot, never overwrites a database with tables,
  and fails closed (throws) when the source is configured but missing. `bin/db-backup.ts`
  is the backup (snapshots into `DATABASE_BACKUP_DIR`, optionally committed to a
  repo of its own).
- **Gateway / bot split.** `src/gateway.ts` only holds the Slack socket and
  writes every envelope to the inbox DB (`INBOX_DATABASE_PATH`). The bot reads it through
  `inboxReceiver`, a Bolt receiver, so every listener in `app.ts` runs exactly
  as it would over Socket Mode. Restarting the bot never drops Slack. With
  `SLACK_TRANSPORT=socket` (the default) the bot holds the socket itself and no
  gateway is needed.
- **One turn per thread, one session per thread.** `threadQueue` serialises
  turns in a thread; `threadSession` keeps one CLI session id per thread and
  resumes it, so the model keeps its context and files between turns.
  `runRegistry` holds a handle on each running turn so it can be stopped.
- **Commands from the brain.** The brain runs real commands through
  `bin/jarvis-run.sh` -> `/api/commands/run`. `commandTickets` mints a one-turn
  ticket bound to the person being answered, so the brain never names the actor
  and cannot escalate. `brainRun` delivers the result per the command's output
  mode (`quiet` comes back to the brain, the rest is posted to the thread). A
  handed-off command that later fails says so in the thread, not only in the log.
- **Timers.** `watcher` polls each due watch's predicate and hands the thread a
  fresh turn when it is ready (`watch worker <dispatchId>` polls an Orca worker
  through `bin/orca-worker-wait.ts` and says whether it finished, died - also
  when it stopped without reporting - or waits for input - a finished or dead worker's hand-back also names the tokens
  and list-price cost its Claude transcript used, stored in
  `orca_worker_usage`, read later with `worker-cost <ctx_...|run_...>`);
  `reminders` posts at the time with no model;
  `loops` (`application/loops.ts`, `db/loopRepo.ts`, `domain/loop.ts`, `loop` command) fires a recurring schedule: a prompt loop hands a turn through the watcher's own `runTurn` (so there is one way to wake a thread), in a fresh top-level DM message to the loop's creator each time, as the creator, on the `loop` model (Sonnet) rather than the creator's role model (`loop: true` on the request -> `model` on the inbound message -> the policy's model); a script loop (`-- <shell>`) is never typed: only the owner's own turn can write one, it is stored pending and DMed to the owner with Approve / Reject `jv:loop:` buttons (`loopApproval.ts`, decided in code like `jv:cloudwatch:`), and only Approve activates it (Reject or 24h of silence deletes it); once active it runs through the watcher's shell runner with no turn, and only a failure posts, to the same DM. A loop is always moved on from now before it fires, so a run missed while down happens once on startup, never as a backlog; a creator who lost the role stops the loop;
  a `watches` row whose check is `ci-gate:{...}` is not shell and hands back no
  turn: `watcher` calls `application/ciGate.ts` instead, which polls the PR's
  checks once a minute and approves or requests changes itself (the CI gate of
  `quick-review`, deadline one hour; see "CI comes first" in the README);
  `reviewInbox` polls GitHub for review requests and only announces them in a
  channel (a quick review starts only when a person asks, never from here); `orcaQuestions` reads the Orca mailbox of every Run a thread
  started a worker in (linked from the turn's tool trace as `worker-start`
  prints it) and hands each question a worker is still blocked on to that
  thread as a turn that answers it with `orca orchestration reply`, once per
  question (`orca_questions`; in a workflow thread on the worker's lane via
  `workerLane`, since the front cannot run `orca`); `workflowContinue` resumes long workflows after a restart;
  `innerChild` watches the bot's own conversations and queues fixes to itself,
  and steers a session whose reply drifted from the voice rules (a private
  nudge to re-check that reply, logged in the drift log channel and
  `drift_events`, never an edit and never a code fix);
  `offlineAlarm` keeps an "I'm offline" notice armed as a Slack scheduled
  message ten minutes out (Slack ignores a cancel within ~5 min of due), so Slack posts it by itself when the host loses
  its connection, and edits it to "back online" when it returns.
  `stuckSweeper` asks Orca every 15 minutes for tasks still `dispatched`
  whose worker is gone, and `gh` for open PRs on the bot's own repo with no
  commit, comment or review for 30 minutes, and DMs the owner what is new with
  the thread that started each (recorded when the app opened the PR, else found in the traces; an item is not repeated for 4 hours);
  `mindful` shows the same two lists on demand.
  None of them hold a session or a queue slot while they wait.
- **Followed threads: debounce and gate.** An untagged message in a thread the bot
  follows (the `asked` and `own-thread` routes; tagged messages, DMs, one-on-one
  threads and command lines skip all of this) is not a turn yet. `app.ts` hands it
  to `followGate` (`application/followGate.ts`), which keeps one batch per thread in
  memory: each arrival resets a quiet window (`follow_debounce_seconds`, 25s), a cap
  from the first message (`follow_debounce_max_seconds`, 90s, at most 600s) bounds
  the wait. When it ends the pal model reads the batch and the few messages before
  it and says `reply`, `skip` or `wait` (`wait` buys one more window, still under the
  cap; an error, a timeout or an unreadable answer is `reply`). Only `reply` runs the
  main turn, once, on all the buffered messages in order. The listener awaits the
  batch, so each message's inbox row stays `running` while it is buffered: a restart
  redelivers those rows and they are buffered again, instead of waiting in memory
  alone. Like the other timers it holds no session and no queue slot while it waits,
  and `follow_gate=off` removes it.
- **GitHub App.** A loopback listener (`GITHUB_APP_PORT`, reached through
  Tailscale Funnel) verifies each webhook, answers 202 and hands it to
  `githubApp`, which keeps only real calls (a mention of the app or its label,
  never from a bot, only in allowed owners' repos) as rows keyed by delivery id
  - the dedupe and the queue, held while a restart drains. Each is posted into
  a channel and run as a turn in that thread as the matched Slack person; the
  turn answers on GitHub through `bin/github-app-comment.sh` ->
  `/api/github-app/comment`, ticketed and bound to that one issue. Beyond that,
  an admin's or the owner's turn can act as the app on any repo it is installed
  on (PRs, comments, reviews, labels, merge) through `bin/github-app.sh` ->
  `/api/github-app/action`: the ticket resolves to the Slack user, the role is
  checked in `githubAppActions`, the installation is looked up per repo, and
  every call lands in the command log. The same helper's `git` / `push` run a
  local git as the app: it asks the bot for the `git-auth` action (installation
  token + `<slug>[bot]` identity) and gives that one git process the token in its
  environment (`GIT_CONFIG_*` `http.extraheader`), never in a url or a file.
  An Orca worker outlives the turn's 20-minute ticket, so a turn mints it a
  **worker ticket** (`worker-ticket`, `workerTickets.ts`, rows in
  `worker_tickets` holding only the token's sha-256): one repo, a short action
  list (no `git`/`push` by default: a worker pushes with the one-shot human
  credential), bound to its dispatch id, 3h (max 6h), ended when the
  `watch worker` sees it finish or die, on `revoke`, or by the expiry sweep. A
  long worker extends it (`ticket-renew` through `bin/github-app.sh`, or an
  admin's `worker-ticket renew`, which also revives one that lapsed unrevoked):
  up to 6h per renewal, 24h from the bind in all. The
  token is handed over as a 0600 file whose PATH is the only thing in the brief
  (`JARVIS_RUN_TICKET_FILE`, read by `bin/github-app.sh`). `githubAppActions`
  redeems it against the plan's action and repo (not the raw request), still
  checks the minter's role, and a `git-auth` token for a worker is minted per
  ticket (repo-narrowed, permission-narrowed, uncached) and revoked at GitHub
  when the ticket ends. It is a separate store from `commandTickets`, so it can
  never run a command, and only the brain's run bridge can mint one.
- **Self-update.** A fix lands through a PR that CI (`.github/workflows/ci.yml`)
  passes (typecheck, tests, the real-Slack e2e on non-fork runs, and a `gitleaks` secret scan whose known false positives are allowlisted by value in `.gitleaks.toml`), merged only by `bin/merge-when-green.sh` (exit 4 at once on a PR that
  conflicts with its base, which GitHub never runs CI on). When it touches runtime code
  (logic, commands, adapters, `bin/` scripts, or a mixed PR) a reviewer Orca worker
  reads it first, up to 5 rounds (each round is a real GitHub review, request changes or approve; fixes are pushes answered by a `[fix round N]` comment); docs,
  prompt text, skills and dashboard UI need no reviewer. `bin/jarvis-restart.sh` runs typecheck and tests and only
  restarts when both pass. With `SELF_PR_AUTHOR`/`SELF_PR_REVIEWER` set, the
  PR is opened as the author and reviewed, approved and merged as the reviewer
  (the reviewer's own approving review is the clean verdict; `merge-when-green.sh` approves right before the merge only when that account has not already approved this head). `restartWhenIdle` then drains: timers that start turns hold, and new
  chat messages are still answered, each turn on `RESTART_TURN_BUDGET_MS` (2 min;
  commands, slash commands and buttons wait in the inbox instead);
  one past it tells its thread to hold on, is cut and its inbox row stays
  `running` with `cut_at` for the next process. Once the turns from before the
  request have finished the inbox is no longer read, so the wait ends within
  one budget, and anyone writing in from then on (or whose command was held
  back before that) is told why, what it waits on and the latest it is back. Past 15 minutes it exits anyway and the rows it cut are
  redelivered to the next process on the same session. Where this goes next is
  in [`docs/rolling-restart.md`](docs/rolling-restart.md).

## Layers

```
                 index.ts / gateway.ts  (composition roots)
                          |
   +---------+-----------+-----------+---------+--------+
   |         |           |           |         |        |
 slack   dashboard      llm         db      github   system   <- infrastructure
   \         |           |           |         |        /
    +--------+----- application (use cases) ---+-------+
                          |
                     domain (pure)
```

### `src/domain` - pure business rules

No I/O, no frameworks. Just data shapes and functions of their inputs.

- `types.ts` - core data shapes (`AllowedUser`, `StoredMessage`, roles: pal/executer/admin/owner)
- `access.ts`, `toolPolicy.ts`, `toolVisibility.ts` - who may talk to the bot, and the per-role CLI sandbox (skip-permissions vs `--allowedTools` allow-list + fixed cwd), incl. the host `notion` MCP server gated by `note`'s floor and the host `datadog` MCP server (read tools only, every role, writes denied by name)
- `agentModels.ts` - the models of handed-off work (`model:subagent|worker|plan|loop`, defaults sonnet/sonnet/opus/sonnet): the turn env and the Explore/Plan `--agents` overrides
- `rolePolicy.ts` - the dashboard-edited policy per role: on/off, and the commands, tools and MCP servers it is denied (restrict-only; the owner is never restricted)
- `slackNames.ts` - how a person or conversation is shown: always name and id
- `personality.ts`, `promptGuides.ts`, `conversation.ts`, `mentions.ts` - the system prompt from generic defaults + injected identity (procedure blocks as on-demand guide files for turns that can read them), context windowing, `<@ID>` annotation
- `threadSession.ts`, `agentSession.ts` - one CLI session per thread and when it may be resumed
- `adapter.ts`, `adapterCheck.ts` - memory as a checked, versioned directory (facts + skills) instead of an ever-growing list
- `ciGate.ts` (domain) - CI verdict of a PR from its check rollup, what a CI-gate poll should do, the spec of a gate's watch row
- `threadFollow.ts`, `followGate.ts` - which untagged thread messages the bot answers, and the pure rules of the gate in front of a followed thread (settings, bypass, batch windows, verdict parsing, the gate's prompt)
- `watch.ts`, `reminder.ts`, `loop.ts`, `selfUpdate.ts`, `runControl.ts`, `threadBackground.ts` - waits, reminders, draining restart, stopping a turn and the background agents its thread started
- `workerUsage.ts` - an Orca worker's tokens summed from its Claude Code transcript (deduped per message) and priced per model (the one price table)
- `offlineAlarm.ts` - the dead man's switch notice and its back-online edit
- `systemStatus.ts`, `orcaStatus.ts`, `systemBlocks.ts` - `sys`: the host verdict and numbers, Orca's runtime/runs/tasks parsed from its CLI JSON and counted, and the Block Kit message (header, fields, trend, Orca table) with the plain report as its fallback
- `innerChild.ts`, `voiceDrift.ts` - the self-review triage, and the cheap voice-drift check, nudge and log lines
- `githubApp.ts` - webhook signature, owner allowlist, trigger detection and what the GitHub App says
- `*Prompt.ts` - prompts for the preset tasks (quick-review, ticket, investigate, read, note, workflow, ...)
- `blockKit.ts`, `kitEvents.ts`, `slackFormat.ts`, `slackLinks.ts` - Slack formatting, Block Kit (model fences are normalised against Slack's min-length rules and can be rendered as words when Slack refuses them) and links
- `usageFooter.ts`, `collapseSteps.ts`, `messageFooter.ts` - the one grey line under a message: who wrote it (Jarvis, inner child Jarvis, watch, reminder, ...), what the turn cost, the step summary, and when it was last updated (restamped on every edit); `signedText` posts plain text as one `markdown` block (never folded behind "Show more", unlike a long section) up to Slack's 12k markdown cap, and `sectionChunks` cuts the rest (and the `signedSections` fallback) into sections Slack accepts, hard-splitting long lines and keeping code fences closed

Fully unit tested, no mocks needed.

### `src/application` - use cases

Orchestrates the domain and depends on **ports**, not concrete adapters.

- `ports.ts` - `LlmPort` (optional streaming + per-call tool `policy`), `Clock` and sink seams
- `respond.ts` - routes an inbound message to command or chat
- `handleMessage.ts` - the chat flow (access -> remember -> ask model -> remember), applying the role's tool policy
- `cloudwatch.ts` (application) + `domain/cloudwatch.ts` + `infrastructure/aws/cloudwatchCli.ts` + `db/cloudwatchRepo.ts` - the `cloudwatch` command: Logs Insights run by the bot's own `aws` CLI (a turn's `aws logs` stays denied), a scan estimate from the log group's stored size, owner runs after a warning, executer/admin park a `cloudwatch_requests` row behind `jv:cloudwatch:confirm|cancel` buttons decided in code (never a model turn), every request audited
- `commands.ts`, `commandTickets.ts`, `workerTickets.ts`, `commandLimits.ts`, `brainRun.ts` - the command registry (configurable prefix + slash, role gates, help), the brain's tickets, allowances and result delivery. The command definitions live in `commands/`, one file per group (`chat`, `schedule`, `people`, `adapter`, `learnings`, `errands`, `review`, `runtime`, `slack`, `cloudwatch`), with `commands/shared.ts` for the deps, the `CommandDef` type and the helpers more than one group uses
- `threadQueue.ts`, `runRegistry.ts` - one turn per thread, and stopping one
- `followGate.ts` (application), `followGateModel.ts` - the per-thread buffer for a followed thread (a quiet window, a hard cap, injectable timers) and the cheap pal-model call that says reply, skip or wait
- `ciGate.ts` (application) - the CI gate of `quick-review`: idempotent request-changes and approve against GitHub's own state, the watcher row for a running CI, and its poll
- `watcher.ts`, `reminders.ts`, `loops.ts`, `reviewInbox.ts`, `reviewGuard.ts`, `innerChild.ts`, `offlineAlarm.ts`, `orcaQuestions.ts`, `stuckSweeper.ts` - the timers (`orcaQuestions` also sits on the tool-trace sink, linking each Orca worker to the thread that started it)
- `githubApp.ts` - calls from the GitHub App: dedupe/queue, identity mapping, the turn, the answer back
- `workflow.ts`, `workflowFront.ts`, `workflowContinue.ts` - long tasks driven from one thread on a durable session
- `accessRequests.ts` - unknown people ask the owner and admins, who decide with a reaction; on ✅ the person's original message (stored whole, with its Slack ts) is answered as a normal turn through the Slack intake, falling back to a short "you are in" line if the replay fails
- `adapterMemory.ts`, `botProfile.ts`, `claudeTokens.ts` - memory, instance identity and CLI tokens
- `slackAdmin.ts`, `draftReply.ts` - Console + power tools port, AI reply drafting
- `dashboard.ts` - the dashboard's use cases (users, roles, memory, identity, commands, usage, modals) over narrow ports, returning an `Outcome` the server maps to a status
- `rolePolicies.ts` - wraps the allowlist so a switched-off role is off it for every check in the bot; the dashboard alone gets the raw repo
- `slackDirectory.ts` - the workspace's members (`users.list`, every cursor page) held in memory for the Users page search, refreshed at most every 10 minutes, one sweep shared by concurrent searches, last good copy kept on a failed refresh; the filter itself is `domain/slackMembers.ts`
- `nameResolver.ts` - cached Slack names (conversations.info / users.info) for the dashboard, so a render never calls Slack per row

Tested with an in-memory SQLite database and a fake `LlmPort`.

### `src/infrastructure` - adapters

Concrete implementations of the seams and the transports.

- `slack/gateway.ts` - the gateway's socket, writing envelopes to the inbox
- `slack/inboxReceiver.ts` - the Bolt receiver that reads the inbox instead of a socket
- `slack/app.ts` - Bolt listeners + slash commands mapping Slack events to `respond`
- `slack/stream.ts`, `slack/fences.ts` - bridges the `LlmStreamSink` onto Slack's `chatStream` (text + `task_update` tool cards held to five reusable slots, Block Kit fences; a blocks chunk Slack refuses is written as its words and the stream carries on), falling back to a single post
- `slack/adminClient.ts` - `SlackAdminPort` over the Slack Web API; every post and edit carries the signed footer (`by` names the poster; `post` also takes a turn's usage, so an unwatched turn's reply shows the same usage line as a live one), falling back to bare text when Slack refuses the blocks
- `slack/offlineAlarmClient.ts` - the offline alarm's scheduled-message calls
- `inbox/inboxRepo.ts` - the inbox queue shared by both processes
- `llm/claudeCli.ts` - the default `LlmPort`, wraps the local `claude` CLI (`--resume`, `stream-json`, per-call policy -> `--allowedTools`/cwd/timeout, the timeout stopping the whole process tree, `turnEnv` for per-turn environment such as the Orca handle and the subagent/worker models, `agents` for the `--agents` definitions that pin Explore and Plan); `killTree.ts`, `toolTraceLog.ts` support it; `backgroundAgents.ts` finds a thread's `claude --bg` sessions and Orca workers in its trace and stops them through their own CLIs for `stop`
- `llm/anthropic.ts` - alternative `LlmPort` backed by the Anthropic API
- `db/` - `bun:sqlite` client, schema + migrations, one repo per table (users, role policies, messages, sessions, watches, reminders, loops, workflows, usage, turn and command logs, Orca worker threads and questions, ...), `secretBox.ts` for encrypted tokens, `tokenKeyStore.ts` for where its key lives (file, or a macOS Keychain item via the `security` CLI, `TOKEN_KEY_SOURCE`)
- `adapter/adapterStore.ts` - the memory adapter in the `adapter_files` table, mirrored to `data/adapter-mirror` so skills can be read by path
- `github/` - `gh` CLI wrapper and review-request polling; the GitHub App's fetch client (`appClient.ts`, RS256 JWT -> cached installation token), credentials from files (`appCredentials.ts`) and webhook listener (`webhookServer.ts`)
- `system/` - host probes (system load, Accessibility access, shell checks for watches, `orcaProbe.ts` reading Orca's status, newest Runs and their tasks for `sys` under one deadline), `guideWriter.ts`, which writes the prompt's how-to guides to `data/prompt-guides`, and `orcaTerminal.ts`, the bot's own Orca terminal (created once, checked against Orca at most once a minute, re-created when gone) whose handle every spawned turn gets as `ORCA_TERMINAL_HANDLE` so it can open Orca Runs and start workers, and `workerTranscript.ts`, which finds an Orca worker's Claude Code session (one message id from `worker-read --source transcript`, matched to the `uuid` in a `~/.claude/projects` jsonl) and sums what it used
- `db/statsRepo.ts` - read-only day buckets and top-N sums over `messages`, `turn_log`, `llm_usage`, `command_log` and `thread_sessions` for the overview charts (`/api/stats`); `domain/dashboardStats.ts` lays them over the whole window, zeros included
- `dashboard/server.ts` - `Bun.serve` JSON API under `/api` plus the React SPA built to `web/dist`. HTTP only: parse, call `application/dashboard.ts`, map the outcome. The brain hooks (`/api/commands/run`, `/api/github-app/comment`, `/api/restart`) and the Slack console call their deps directly
- `web/` - the dashboard front end: React 19 + Vite + React Router 7 (`react-router` package). Its Architecture page draws this document as an interactive diagram from `web/src/systemModel.ts` - change that file with the runtime section above. Layout: `routes/router.tsx` (route table), `pages/` (one module per page with its loader and action), `ui/` (shell, error and banner), `api.ts` (every fetch)

### `src/config`

- `env.ts` - zod-validated environment config, fails fast at boot

### Composition roots

- `src/index.ts` - imports every layer, builds the graph, starts the Slack
  listener (socket or inbox), the timers and the dashboard
- `src/gateway.ts` - reads only `SLACK_APP_TOKEN` and the inbox path, on
  purpose, so a new bot setting can never stop the gateway from starting

## Key decisions

- **Functional throughout.** Repos are factory functions closing over the db
  handle and returning a bag of functions. No classes anywhere.
- **Ports and adapters.** Use cases depend on `LlmPort`/`Clock`, so tests inject
  fakes and never touch the network or the wall clock.
- **Slack never drops on a restart.** The gateway runs under its own supervisor
  and is not restarted with the bot.
- **Sessions, not transcripts.** A thread resumes its CLI session instead of
  replaying history into a cold process, and the session id lives in the DB so
  a restart does not lose it.
- **Waiting costs nothing.** Watches, reminders and polls run on timers in the
  bot process, outside every turn: no model, no session, no queue slot.
- **Owner can never be locked out.** `decideAccess` grants the owner access even
  if the database is empty or broken.
- **Role-based tool policy.** owner/admin run the CLI full-access; pal/executer
  are sandboxed (allow-list + fixed cwd, no permission bypass). Orca is
  owner-only (`ORCA_DENY` in `--disallowedTools` for the other three, since an
  Orca worker runs with full host permissions); an executer gets code jobs
  done in its own process with the Agent tool, and the prompt is role-aware
  (`orca` flag on `buildSystemPrompt`). `quick-review` is a
  preset that always runs full-access. On top of that, a per-role policy edited
  from the dashboard (`role_policies`) can switch a role off or deny it
  commands, tools and MCP servers - it only ever takes away, and never touches
  the owner.
- **The brain never names the actor.** Commands it runs carry a ticket bound to
  the person it is answering.
- **The DB is committed** so identity/allowlist ship with the repo. Conversation
  content is cleared before commit; WAL sidecars are gitignored and flushed on
  clean shutdown.
- **Nothing bot-specific is hardcoded.** Identity lives in the DB; command
  triggers, model, cwd, etc. come from env. The code ships neutral defaults.

## Testing strategy

TDD, bottom-up: domain (pure) -> repos (`:memory:`) -> use cases (fakes) ->
dashboard (via its exported `handle`) -> the Slack handler (via the extracted
`createHandler`/`shouldHandleDm`, with fake clients/streamers).
