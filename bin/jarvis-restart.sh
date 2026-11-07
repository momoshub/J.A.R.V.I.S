#!/usr/bin/env bash
# Verify the bot's own source, then ask it to restart into the change.
#
#   jarvis-restart.sh [--check-only]
#
# The restart is NOT done here. A `launchctl kickstart` from inside a turn kills
# the turn that asked for it, so the reply never lands. Instead this asks the
# running bot, over loopback, to exit once it is idle - after its reply has
# posted and no turn is running in any thread - and launchd brings it back.
# While it waits it takes no new work (messages queue in the inbox), and past
# 15 minutes it exits anyway; the turns it cut are picked up again after.
#
# Typecheck and tests both have to pass. Restarting into code that does not
# compile means crash-looping every fifteen seconds with no way back from Slack.
set -uo pipefail

REPO=${JARVIS_REPO:-$(cd "$(dirname "$0")/.." && pwd)}
PORT=${DASHBOARD_PORT:-2002}
cd "$REPO" || { echo "cannot enter $REPO" >&2; exit 2; }

echo "== typecheck"
if ! bun run typecheck; then
  echo "REFUSING TO RESTART: typecheck failed" >&2
  exit 1
fi

echo "== tests"
if ! bun test; then
  echo "REFUSING TO RESTART: tests failed" >&2
  exit 1
fi

if [ "${1:-}" = "--check-only" ]; then
  echo "checks passed; not restarting (--check-only)"
  exit 0
fi

echo "== asking the bot to restart"
out=$(curl -s --max-time 10 -X POST "http://127.0.0.1:${PORT}/api/restart" \
  -H 'content-type: application/json' -d '{}')
if printf '%s' "$out" | grep -q '"ok":true'; then
  echo "checks passed; restarting once idle (reply lands first, new messages queue, running turns get up to 15 min, then are cut and picked up again)"
else
  echo "checks passed, but the restart request failed: $out" >&2
  exit 1
fi
