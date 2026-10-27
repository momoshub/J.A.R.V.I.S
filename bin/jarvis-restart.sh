#!/usr/bin/env bash
# Verify the bot's own source, then ask it to restart into the change.
#
#   jarvis-restart.sh [--check-only]
#
# The restart is NOT done here. A `launchctl kickstart` from inside a turn kills
# the turn that asked for it, so the reply never lands. Instead this asks the
# running bot, over loopback, to exit a few seconds from now - after its reply
# has posted - and launchd brings it straight back.
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
  echo "checks passed; restarting in a few seconds (reply will land first)"
else
  echo "checks passed, but the restart request failed: $out" >&2
  exit 1
fi
