# Architecture

E.V. follows a clean, layered architecture. Dependencies point inward: outer
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

- `types.ts` - core data shapes (`AllowedUser`, `StoredMessage`, ...)
- `access.ts` - who may talk to E.V. and who may manage users
- `conversation.ts` - context windowing and inbound-text cleanup
- `personality.ts` - the system prompt (E.V.'s Tony Stark voice)

Fully unit tested, no mocks needed.

### `src/application` - use cases

Orchestrates the domain and depends on **ports**, not concrete adapters.

- `ports.ts` - `LlmPort`, `Clock` seams
- `handleMessage.ts` - the chat flow (access -> remember -> ask model -> remember)
- `commands.ts` - parse and execute `!` admin commands
- `respond.ts` - routes an inbound message to command or chat

Tested with an in-memory SQLite database and a fake `LlmPort`.

### `src/infrastructure` - adapters

Concrete implementations of the seams and the transports.

- `db/` - `bun:sqlite` client, schema/migration, repos (`userRepo`, `messageRepo`), owner seed
- `llm/claudeCli.ts` - the default `LlmPort`, wraps the local `claude` CLI for full tool access. `complete` uses `--output-format json`; `stream` uses `--output-format stream-json --include-partial-messages` and forwards text deltas + tool events to a sink
- `llm/anthropic.ts` - alternative `LlmPort` backed by the Anthropic API (no streaming; callers fall back to `complete`)
- `slack/app.ts` - Socket Mode listener mapping Slack events to `respond`
- `slack/stream.ts` - bridges the `LlmStreamSink` onto Slack's `chatStream` (text + `task_update` tool cards); Slack owns the message, appends are serialised, and a failed stream falls back to a single post
- `dashboard/` - `Bun.serve` admin UI and JSON API (pure `views.ts` renderer)

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
- **Runtime DB is gitignored.** Schema + seed are committed code; the live
  `.db` file is reproducible and kept out of git to avoid churn and leaking
  conversation content.

## Testing strategy

TDD, bottom-up: domain (pure) -> repos (`:memory:`) -> use cases (fakes) ->
dashboard (via its exported `handle`). The only untested surface is the thin
Slack event mapping, which is validated by a boot smoke test.
