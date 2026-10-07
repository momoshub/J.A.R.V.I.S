#!/usr/bin/env bash
# Run one of the bot's own commands, as whoever this turn is talking to.
#
#   jarvis-run.sh <endpoint> <command line...>
#
# The ticket is NOT an argument. It is read from JARVIS_RUN_TICKET, which the
# bot puts in this process's environment when it spawns the turn.
#
# That is the whole point. A thread holds one long-lived CLI session, so the
# model's context accumulates every system prompt it has ever been handed - and
# when the ticket was printed in those prompts, the model would sooner or later
# type an old one. Tickets expire, are spent, and die with a restart, so a
# resumed session would reach a point where every command came back "that ticket
# is not valid any more" and nothing could fix it from inside the conversation.
# The environment of a process cannot be stale: it was set when this turn began.
#
# It also closes a worse door. An old ticket in that context belonged to
# whoever was speaking at the time, so reusing one would have run a command as
# somebody else - the exact escalation the ticket exists to prevent.
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: jarvis-run.sh <endpoint> <command line...>" >&2
  exit 2
fi

ticket=${JARVIS_RUN_TICKET:-}
if [ -z "$ticket" ]; then
  echo "no ticket in this turn's environment - I cannot run a command here" >&2
  exit 3
fi

endpoint=$1
shift

# A resumed session remembers the old signature, which passed the ticket as the
# second argument. Drop a leading ticket-shaped token so an old habit runs the
# command instead of turning the ticket into part of it.
if [[ "${1:-}" =~ ^[0-9a-f]{32}$ ]]; then
  shift
fi

line="$*"
if [ -z "$line" ]; then
  echo "usage: jarvis-run.sh <endpoint> <command line...>" >&2
  exit 2
fi

payload=$(TICKET="$ticket" LINE="$line" python3 -c 'import json,os; print(json.dumps({"ticket": os.environ["TICKET"], "line": os.environ["LINE"]}))')
curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$endpoint"
