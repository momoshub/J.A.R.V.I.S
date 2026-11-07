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
# Endpoint: GITHUB_APP_COMMENT_URL, else the loopback dashboard on
# DASHBOARD_PORT (default 2001).
set -uo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: github-app-comment.sh <owner/repo> <issue-or-pr-number> <body-file>" >&2
  exit 2
fi

ticket=${JARVIS_RUN_TICKET:-}
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

endpoint=${GITHUB_APP_COMMENT_URL:-http://127.0.0.1:${DASHBOARD_PORT:-2001}/api/github-app/comment}
payload=$(TICKET="$ticket" REPO="$repo" NUM="$number" FILE="$file" python3 -c '
import json, os
print(json.dumps({
    "ticket": os.environ["TICKET"],
    "repo": os.environ["REPO"],
    "number": int(os.environ["NUM"]) if os.environ["NUM"].isdigit() else 0,
    "body": open(os.environ["FILE"], encoding="utf-8").read(),
}))')
curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$endpoint"
