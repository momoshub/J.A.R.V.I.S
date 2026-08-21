#!/usr/bin/env bash
# Run one of the bot's own commands, as whoever the ticket was issued to.
#
#   jarvis-run.sh <endpoint> <ticket> <command line...>
#
# The ticket carries the actor, so this cannot be pointed at somebody else -
# which is what makes it safe to hand to a sandboxed session.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: jarvis-run.sh <endpoint> <ticket> <command line...>" >&2
  exit 2
fi

endpoint=$1
ticket=$2
shift 2
line="$*"

payload=$(TICKET="$ticket" LINE="$line" python3 -c 'import json,os; print(json.dumps({"ticket": os.environ["TICKET"], "line": os.environ["LINE"]}))')
curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$endpoint"
