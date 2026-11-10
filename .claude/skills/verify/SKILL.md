---
name: verify
description: Verify a Jarvis PR as a separate verifier - fast gate, per-change-type proof, evidence for the PR, what a verifier must never do.
---

# Verifying a Jarvis PR

The session that wrote a PR never declares it done. A separate verifier (a fresh session or Orca worker, never the writer, never a fork of it) proves the change works and posts evidence on the PR. "Tests pass" is the gate, not the proof.

## Setup

- Verify the PR head, nothing else: `gh pr view <pr> --json headRefOid` and check it out in your own worktree (`git fetch`, `git worktree add .claude/worktrees/<name> <headRefOid>`). Never check out or edit in the main checkout (the folder the bot runs from), never touch `data/*.db`.
- Read the diff first (`gh pr diff <pr>`) and the PR body: what is the change supposed to do? Write that down as one sentence you can falsify.
- `git diff --name-only origin/main`: `src/` changed with no `*.test.ts` and no doc is already a finding.

## Fast gate (every PR)

```bash
bun run typecheck          # tsc --noEmit
bun test                   # whole suite, bun:test
cd web && bunx tsc --noEmit   # only if web/ changed; then bun run build:web from the root
```

- Scope while iterating: `bun test <path>` (a file, e.g. `bun test src/domain/watch.test.ts`, or a folder such as `tests/domain`) and `bun test -t "<test name>"`. Tests sit next to the code (`src/**/*.test.ts`) and under `tests/` (`application`, `bin`, `config`, `domain`, `infrastructure`, `web`).
- Finish with the full `bun test`: a scoped run proves nothing about what else moved. `tests/web/systemModel.test.ts` and `systemDesign.test.ts` fail when the runtime shape, schema or a cited constant changed without `web/src/systemModel.ts` / `systemDesign.ts`.
- `bun run test:e2e` is real Slack (`JARVIS_E2E=1`, needs `SLACK_BOT_TOKEN`); run it for changes to streaming, Block Kit, uploads or watch posting. CI runs it with the `JARVIS_E2E_SLACK_BOT_TOKEN` secret.
- CI (`.github/workflows/ci.yml`, job `checks`) = install, typecheck, tests, e2e, then `web/` typecheck and build. Green CI on the head commit is required, not a substitute for the steps below.

## Behaviour, by change type

Run the real thing where you safely can; otherwise show the test that exercises it and say why live was not possible. Never start a second bot (`bun start`) against the live DB or Slack tokens: Slack splits events across connections and the live `data/` is not yours.

- **A command** (`src/application/commands/*`): the test in `commands*.test.ts` (fixtures in `commandsFixture.ts`) covers the happy path, the role gate (`minRole`) and a bad argument; also check `<command> help` and `help` list it. Live: type `<COMMAND_PREFIX> <cmd>` in the private #jarvis_self_testing channel as a role that may run it, and one that may not.
- **An adapter / Slack path** (`src/infrastructure/slack/*`, `inboxReceiver`, `stream`, `adminClient`): `bun run test:e2e` for the touched file, plus a Slack thread read back with `bin/slack-read.sh replies <channel> <thread-ts>` showing the posted result (names, footer, no raw ids, no duplicate message).
- **A watch / timer** (`watcher`, `reminders`, `stuckSweeper`, `orcaQuestions`, ...): the test with an injected clock fires, does not double-fire, and ends (expired/failed) with a post. Live: set a short one (`watch ... --every 15s --until 2m`, or `remind`) and show it firing once in the thread. For `bin/orca-worker-wait.ts` run it against a real dispatch id.
- **A `bin/` script**: run it for real with its documented arguments and show exit code and output for success AND the failure it guards (`bin/merge-when-green.sh` exits 0/1/3/4). Check it is portable (GNU vs BSD `mktemp`, `sed -i`, `stat`). `tests/bin` holds the existing script tests.
- **Dashboard UI** (`web/`): `cd web && bunx tsc --noEmit`, `bun run build:web`, the `tests/web` suite; the page reads `web/dist` per request, so after a build open it on the dashboard and attach a screenshot of the changed view in light and dark (colours only via CSS variables in `styles.css`). The API half is `src/application/dashboard.ts`: test it there.
- **Prompt, guide or adapter skill text** (`*Prompt.ts`, `promptGuides.ts`, `personality.ts`, adapter skills): the test that pins the text passes, the prompt-fingerprint test still holds (`promptFingerprint`: a rule change reopens live threads, say so), and the text is checked by what the model DOES, counted from `tool_use` blocks in `stream-json`, never by asking it what it would do. Docs-only: grep that every command, path and script named exists.

## Evidence to attach (PR comment)

Post one comment `[verify]` on the PR (as the `SELF_PR_REVIEWER` account: `GH_TOKEN=$(gh auth token -u "$SELF_PR_REVIEWER") gh pr comment <pr> ...`; empty token = stop, never `gh auth switch`) containing:

- the head SHA you verified (`git rev-parse HEAD` in your worktree equals the PR's `headRefOid`)
- the exact commands run and their trimmed output (typecheck, scoped and full `bun test` counts)
- the behaviour proof for the change type above: command output, thread permalink, log line, screenshot, exit codes
- what you could not verify and why
- a verdict line: `VERDICT: verified` or `VERDICT: not verified - <what is missing or broken>`

## A verifier must not

- approve or merge its own patch: if you changed code to make it pass, you are now the writer, push it as a fix and ask for another verifier
- verify a commit other than the PR head: a push after you started voids the run, re-check the SHA before posting
- claim verified without evidence in the comment, or on the strength of the writer's own description, CI alone or "looks right"
- edit the main folder, rewrite `data/*.db` (`git stash`, `checkout`, `reset`, `rebase` swap the live database), restart the bot to "see if it works", or run `bin/jarvis-restart.sh`
- add attribution, a co-author trailer or "Generated with" to anything

## Regression -> guard

A fix for a bug that slipped through also adds the test (or lint/type rule, or CI step) that would have caught it, in the same PR, and the PR body names it: "guard: `<test file>` - fails on the old code". Run that test against the pre-fix code to prove it fails there.
