# E.V.

A Slack bot with the temperament of Tony Stark: brilliant, quick, lightly sarcastic, and actually useful. Named after E.V. from Spider-Man: Brand New Day.

E.V. talks only to an allowlist of Slack users, remembers each channel's conversation in a local SQLite database, and is managed either from Slack (`!` commands) or a web dashboard on port `2001`.

## Stack

- **Bun** + **TypeScript**, functional style (no classes)
- **@slack/bolt** in Socket Mode (no public URL needed)
- **@anthropic-ai/sdk** for the brain
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
| `ANTHROPIC_API_KEY` | powers E.V.'s replies |
| `ANTHROPIC_MODEL` | defaults to `claude-opus-4-8` |
| `OWNER_SLACK_ID` | the owner, cannot be removed (default `U0OWNER0001`) |
| `DASHBOARD_PORT` | dashboard port (default `2001`) |
| `DASHBOARD_TOKEN` | token to reach the dashboard |
| `DATABASE_PATH` | sqlite file (default `data/ev.db`) |

## Run

```bash
bun run db:seed   # optional; boot also seeds the owner
bun start         # or: bun dev  (watch mode)
```

The Slack app needs Socket Mode on, plus the `app_mention` and `message.im` event subscriptions and the `chat:write`, `app_mentions:read`, `im:history`, `users:read` scopes.

## Talking to E.V.

- DM her, or @-mention her in a channel she is in
- She replies in-thread on mentions, inline in DMs
- She only answers allowlisted users; the owner is always allowed

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

Open `http://localhost:2001/?token=YOUR_DASHBOARD_TOKEN`. View stored-turn and user counts, add or revoke users. The owner cannot be revoked.

## Testing

```bash
bun test          # full suite
bun run typecheck  # tsc --noEmit
```

## Notes

- The runtime database (`data/*.db`) is gitignored on purpose. It holds live conversation content and would churn on every message. The schema and owner seed are code, so the database is fully reproducible.
- Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).
