# CLAUDE.md

Guidance for working on this repo. Keep it accurate - update it when behavior, structure, or conventions change.

## What this is

A configurable Slack agent bot (Bun + TypeScript). Its "brain" is the local **Claude Code CLI** (default) or the Anthropic API. It has SQLite memory, an allowlist with roles, live streaming replies, a command registry, and a React admin dashboard. The code is **generic** - the running instance's identity (name, persona, prefixes, etc.) lives in the DB / env, never hardcoded.

## Commands

```bash
bun test              # full test suite (bun:test)
bun run typecheck     # tsc --noEmit  (root)
bun run build:web     # build the React dashboard (web/ -> web/dist)
bun start             # run the bot + dashboard
bun run setup         # install + build:web
```

Always run `bun run typecheck` AND `bun test` before considering a change done. The `web/` app has its own `tsconfig`/deps - typecheck it with `cd web && bunx tsc --noEmit` after touching it, and rebuild (`bun run build:web`) since the bot serves `web/dist`.

## Architecture (clean, layered - dependencies point inward)

- `src/domain` - pure logic, no I/O: `types`, `access` (roles), `conversation`, `mentions`, `personality`, `toolPolicy`, `reviewPrompt`, `emoji`, `slackLinks`
- `src/application` - use cases + ports: `ports` (`LlmPort`), `handleMessage`, `respond`, `commands` (registry), `botProfile`, `slackAdmin`, `draftReply`
- `src/infrastructure` - adapters: `db/*` (bun:sqlite repos + schema/migration), `llm/claudeCli` + `llm/anthropic`, `slack/app` + `slack/adminClient` + `slack/stream`, `dashboard/server`
- `src/config/env.ts` - zod-validated env, fails fast
- `src/index.ts` - the only composition root; wires everything
- `web/` - React 19 + Vite + React Router 7 dashboard (JSON API under `/api`)
- Full docs: `README.md`, `ARCHITECTURE.md`

## Conventions

- **TypeScript, functional style. No classes** - repos/adapters are factory functions returning a bag of functions. Do not introduce OOP.
- **Never use `any`.** Use precise types; `unknown` + narrowing at boundaries.
- Local imports use explicit `.ts` extensions (Bun style).
- Use `bun:sqlite`; SQL is parameterized (named/positional binds), never string-concatenated.
- Depend on ports (`LlmPort`, `SlackAdminPort`, injected clocks/deps), not concrete adapters, so use cases stay testable with fakes + `:memory:` sqlite.
- Keep changes small and focused; add/adjust tests with any behavior change (TDD).

## Key facts (non-obvious)

- **Identity is data, not code.** Bot name/persona/labels live in the DB `settings` table (seeded, editable from the dashboard). Command triggers (`COMMAND_PREFIX`, `SLASH_COMMAND`), model, cwd, owner id, etc. come from env. Do NOT hardcode instance-specific strings (bot name, command prefix, db filename) in `src/` - the code defaults are neutral (`Assistant`, `//bot`, `data/bot.db`) and each instance overrides via env + DB.
- **The DB is committed** (path from `DATABASE_PATH`) and carries the allowlist + identity. Conversation `messages` are cleared before committing; WAL sidecars are gitignored. After schema changes, migrations run via `PRAGMA user_version` in `db/schema.ts`.
- **`ALWAYS_DISALLOW`** (`domain/toolPolicy.ts`) is denied to every role including full access - `--disallowedTools` is honoured alongside `--dangerously-skip-permissions` (verified), so it is a real denial. It holds the Slack MCP connectors (they post as the authorising human, not as the bot) and CloudWatch.
- **Roles** (`src/domain/access.ts`, `toolPolicy.ts`): `pal` < `executer` < `admin` < `owner`. owner/admin run the CLI full-access; pal/executer are sandboxed (`--allowedTools` allow-list, no `--dangerously-skip-permissions`, fixed cwd). `review` is a preset that always runs full-access and writes to the PR.
- **Workflows** (`application/workflow.ts`, `db/workflowRepo.ts`) bind a Slack thread to a durable CLI session: the first turn passes `--session-id <uuid>`, every later turn `--resume <uuid>`, so the model keeps its context and files. `respond` routes plain messages in a workflow thread to that session instead of the chat brain. `executer`+ only.
- **The brain can run commands** for anyone it is talking to: `bin/jarvis-run.sh` posts to `POST /api/commands/run` on the loopback dashboard, which the composition root wires to `dispatchCommand`. The request carries a **ticket**, never an actor - `application/commandTickets.ts` mints one per turn bound to the current speaker, so a sandboxed session cannot name someone else and escalate. The command's own `minRole` still gates what runs.
- **Investigation** (`domain/investigation.ts`): logs/metrics/traces come from Grafana via the `gcx` CLI first, Datadog second, and never CloudWatch (billed per GB). The order is a setting (`log_sources`, `logsource` command); the CloudWatch refusal is both a prompt rule and a `SANDBOX_DISALLOW` entry, since a full-access role cannot be denied anything.
- **Tickets** (`domain/ticketPrompt.ts`): a preset full-access task like `review`. It reads the configured Notion SOP + pod pages + the tracker schema at run time and routes from those, so no pod, person or property name is ever hardcoded; settings are `ticket_tracker`, `ticket_sop`, `ticket_pods`, `ticket_repos`. `ticketChatRules` lets a bug reported in plain chat become a ticket. A PR is only opened for a small, verifiable fix, with a reviewer justified from CODEOWNERS/git history; `ticket_repos` accepts whole orgs as well as `owner/repo` (`parseRepoScope`), and an org grant makes the bot verify membership with `gh repo view` before pushing. A measured Risk section is added when the issue is not trivial.
- **Slack output** (`domain/slackFormat.ts`): `SLACK_FORMAT` + `SLACK_BREVITY` are shared by the chat prompt, `ticketPrompt` and `reviewPrompt`'s close-out. Slack is mrkdwn, not Markdown - `**bold**` and `[x](y)` render literally - so any new prompt that produces Slack text must include them.
- **Commands** are a single registry in `src/application/commands.ts`, invoked as `<COMMAND_PREFIX> <cmd>`, the `<SLASH_COMMAND> <cmd>` slash, or legacy `!<cmd>`. Add a command = one entry; it gets role-gating, logging, and dashboard listing for free.
- **The bot's runtime ignores this CLAUDE.md** - the bot runs the CLI in a temp cwd with an identity-lock that ignores CLAUDE.md/memory. This file is for developer / Claude Code sessions editing the repo.

## Running instance / ops

- The bot runs under **launchd** (`~/Library/LaunchAgents/com.acme.jarvis.plist`), so it starts at login and is revived if it dies. Restart after a change with `launchctl kickstart -k gui/$UID/com.acme.jarvis`; `pkill` will NOT stop it (KeepAlive revives it in 15s) - use `launchctl bootout gui/$UID/com.acme.jarvis`. Output goes to `logs/jarvis.{out,err}.log`.
- **Never restart while a turn is in flight**: check `pgrep -f "claude -p"` first, or a review/workflow mid-run is killed (exit 143).
- Commit or push only when asked. Do not commit secrets (`.env` is gitignored).
