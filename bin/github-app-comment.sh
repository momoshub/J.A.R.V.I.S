#!/usr/bin/env bash
# Post a turn's answer to GitHub as the GitHub App.
#
#   github-app-comment.sh <owner/repo> <issue-or-pr-number> <body-file>
#
# Like jarvis-run.sh, the ticket comes from JARVIS_RUN_TICKET in this process's
# environment, never from an argument. The bot resolves it to the Slack thread
# this turn runs in, and only posts if that thread was opened for exactly this
# issue/PR - so a turn can answer the call it came from and nothing else. The
# app's private key never reaches the turn; the bot holds it.
#
# Endpoint, first that is set: GITHUB_APP_COMMENT_URL; the loopback dashboard on
# DASHBOARD_PORT; the base URL on line 2 of the JARVIS_RUN_TICKET_FILE (a
# worker's ticket file; its shell has no DASHBOARD_PORT); else 2001. A failed
# call names the endpoint it tried.
set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: github-app-comment.sh <owner/repo> <issue-or-pr-number> <body-file>" >&2
  exit 2
fi

ticket=${JARVIS_RUN_TICKET:-}
ticket_base=
# A worker's ticket file: line 1 the token, line 2 (optional) where the bot listens.
if [ -z "$ticket" ] && [ -n "${JARVIS_RUN_TICKET_FILE:-}" ]; then
  ticket=$(sed -n 1p "$JARVIS_RUN_TICKET_FILE" 2>/dev/null | tr -d '[:space:]')
  ticket_base=$(sed -n 2p "$JARVIS_RUN_TICKET_FILE" 2>/dev/null | tr -d '[:space:]')
  case "$ticket_base" in
    http://127.0.0.1:[0-9]*) ;;
    *) ticket_base= ;;
  esac
fi
if [ -z "$ticket" ]; then
  echo "no ticket in this turn's environment - I cannot post to GitHub here" >&2
  exit 3
fi

repo=$1
number=$2
file=$3
if [ ! -s "$file" ]; then
  echo "body file $file is missing or empty" >&2
  exit 2
fi

# Explicit URL, then DASHBOARD_PORT, then the ticket file's base URL, then 2001.
if [ -n "${GITHUB_APP_COMMENT_URL:-}" ]; then
  endpoint=$GITHUB_APP_COMMENT_URL
elif [ -z "${DASHBOARD_PORT:-}" ] && [ -n "$ticket_base" ]; then
  endpoint=$ticket_base/api/github-app/comment
else
  endpoint=http://127.0.0.1:${DASHBOARD_PORT:-2001}/api/github-app/comment
fi
payload=$(TICKET="$ticket" REPO="$repo" NUM="$number" FILE="$file" python3 -c '
import json, os
print(json.dumps({
    "ticket": os.environ["TICKET"],
    "repo": os.environ["REPO"],
    "number": int(os.environ["NUM"]) if os.environ["NUM"].isdigit() else 0,
    "body": open(os.environ["FILE"], encoding="utf-8").read(),
}))')
response=$(curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$endpoint")
if [ -z "$response" ]; then
  echo "no usable answer from the bot at $endpoint" >&2
  exit 1
fi
printf '%s\n' "$response"
