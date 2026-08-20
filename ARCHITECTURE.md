# Architecture

the bot follows a clean, layered architecture. Dependencies point inward: outer
layers know about inner ones, never the reverse. Every layer is functional -
factories and pure functions, no classes.

```
                 index.ts  (composition root)
                     |
   +-----------------+------------------+
   |                 |                  |
 slack            dashboard          (llm)          <- infrastructure
   \                 |                  /
    \                |                 /
     +----- application (use cases) --+
                     |
                 domain (pure)
```

## Layers

### `src/domain` - pure business rules

No I/O, no frameworks. Just data shapes and functions of their inputs.

- `types.ts` - core data shapes (`AllowedUser`, `StoredMessage`, roles: pal/executer/admin/owner)
- `access.ts` - who may talk to the bot and who may manage users
- `conversation.ts` - context windowing; `mentions.ts` - annotate `<@ID>` -> `<@ID:Name>` before the model sees a message
- `personality.ts` - builds the system prompt from generic defaults + injected identity (no hardcoded bot)
- `toolPolicy.ts` - per-role CLI sandbox policy (skip-permissions vs `--allowedTools` allow-list + fixed cwd)
- `reviewPrompt.ts`, `emoji.ts`, `slackLinks.ts` - helpers for the power-tool commands (review / bomb / reply)

Fully unit tested, no mocks needed.

### `src/application` - use cases

Orchestrates the domain and depends on **ports**, not concrete adapters.

- `botProfile.ts` - loads the instance identity (name, persona, labels) from settings, DB-first
- `ports.ts` - `LlmPort` (optional streaming + per-call tool `policy`), `Clock` seams
- `handleMessage.ts` - the chat flow (access -> remember -> ask model -> remember), applying the role's tool policy
- `commands.ts` - the command registry: dual-interface (configurable prefix + slash), per-command role gates, help, and the power tools (review / bomb / reply)
- `slackAdmin.ts` - port for the Console + power tools (list/history/thread/edit/delete/post/react)
- `draftReply.ts` - AI reply drafting (Console + the reply command)
- `respond.ts` - routes an inbound message to command or chat

Tested with an in-memory SQLite database and a fake `LlmPort`.

### `src/infrastructure` - adapters

Concrete implementations of the seams and the transports.

- `db/` - `bun:sqlite` client, schema + role migration, repos (`userRepo`, `messageRepo`, `learningsRepo`, `settingsRepo`, `commandLogRepo`), owner seed
- `llm/claudeCli.ts` - the default `LlmPort`, wraps the local `claude` CLI. `complete` uses `--output-format json`; `stream` uses `--output-format stream-json --include-partial-messages` and forwards text deltas + tool events to a sink. The per-call `policy` maps to `--allowedTools`/`--disallowedTools`/cwd/timeout
- `llm/anthropic.ts` - alternative `LlmPort` backed by the Anthropic API (no streaming; callers fall back to `complete`)
- `slack/app.ts` - Socket Mode listener + slash commands mapping Slack events to `respond`
- `slack/adminClient.ts` - `SlackAdminPort` over the Slack Web API (Console + power tools)
- `slack/stream.ts` - bridges the `LlmStreamSink` onto Slack's `chatStream` (text + `task_update` tool cards); Slack owns the message, appends are serialised, and a failed stream falls back to a single post
- `dashboard/server.ts` - `Bun.serve` JSON API under `/api` plus static hosting of the React SPA built to `web/dist`
- `web/` - the dashboard front end: React 19 + Vite + React Router 7 (data-router with loaders/actions), talking to the JSON API

### `src/config`

- `env.ts` - zod-validated environment config, fails fast at boot

### `src/index.ts` - composition root

The single place that imports every layer, builds the graph, and starts the
Slack listener and dashboard.

## Key decisions

- **Functional throughout.** Repos are factory functions closing over the db
  handle and returning a bag of functions. No classes anywhere.
- **Ports and adapters.** Use cases depend on `LlmPort`/`Clock`, so tests inject
  fakes and never touch the network or the wall clock.
- **Owner can never be locked out.** `decideAccess` grants the owner access even
  if the database is empty or broken.
- **Memory is per-channel** and windowed (`DEFAULT_CONTEXT_WINDOW`) so prompts
  stay bounded no matter how long a channel has been chatting.
- **Role-based tool policy.** owner/admin run the CLI full-access; pal/executer
  are sandboxed (allow-list + fixed cwd, no permission bypass). `review` is a
  preset that always runs full-access.
- **The DB is committed** (`data/bot.db` by default; this instance uses
  `data/ev.db`) so identity/allowlist ship with the repo. Conversation content is
  cleared before commit; WAL sidecars are gitignored and flushed on clean shutdown.
- **Nothing bot-specific is hardcoded.** Identity lives in the DB; command
  triggers, model, cwd, etc. come from env. The code ships neutral defaults.

## Testing strategy

TDD, bottom-up: domain (pure) -> repos (`:memory:`) -> use cases (fakes) ->
dashboard (via its exported `handle`) -> the Slack handler (via the extracted
`createHandler`/`shouldHandleDm`, with fake clients/streamers).
