#!/usr/bin/env bash
# Call the Slack Web API through the bot, without ever holding its token.
#
#   slack-api.sh <method> [key=value ...]
#   slack-api.sh chat.postMessage channel=C0123 thread_ts=1700000000.000100 text='done, see the PR'
#   slack-api.sh conversations.replies channel=C0123 ts=1700000000.000100 limit=50
#
# A turn's environment carries no Slack token: a model that reads untrusted
# text can be talked into running `env` or a `curl`, and a token in reach is a
# token gone. What it carries is JARVIS_SLACK_TICKET, minted for this one run and
# dead when it ends. This script hands that ticket and the call to the bot over
# loopback; the bot checks it, applies its allowlist and makes the call with the
# token it holds. Slack's own answer comes back unchanged (`ok`, `error`, ...).
#
# What the bot will call (anything else is refused with `method_not_allowed`):
#   read   conversations.history, conversations.replies, conversations.info,
#          conversations.list (public channels), conversations.join (public),
#          users.info
#   write  chat.postMessage, chat.update, reactions.add,
#          files.getUploadURLExternal, files.completeUploadExternal
# A write only works in the channel this turn runs in (`channel_not_allowed`
# otherwise). Values are plain strings; `blocks` and `files` are JSON strings.
# Downloading a private file is slack-file.sh, uploading one slack-upload.sh.
#
# Endpoint: JARVIS_SLACK_API_URL (the bot sets it), else the loopback dashboard
# on DASHBOARD_PORT (default 2001).
set -uo pipefail

if [ "$#" -lt 1 ] || [[ "$1" == -* ]]; then
  sed -n '2,25p' "$0" >&2
  exit 2
fi

method=$1
shift

ticket=${JARVIS_SLACK_TICKET:-}
if [ -z "$ticket" ]; then
  echo "no Slack ticket in this turn's environment - I cannot call Slack here" >&2
  exit 3
fi

base=${JARVIS_SLACK_API_URL:-http://127.0.0.1:${DASHBOARD_PORT:-2001}/api/slack}

# Through stdin, never argv: argv is visible in `ps` and the text may be long.
payload=$(TICKET="$ticket" METHOD="$method" python3 -c '
import json, os, sys
params = {}
for arg in sys.argv[1:]:
    key, sep, value = arg.partition("=")
    if not sep or not key:
        sys.stderr.write("expected key=value, got: %s\n" % arg)
        sys.exit(2)
    params[key] = value
print(json.dumps({"ticket": os.environ["TICKET"], "method": os.environ["METHOD"], "params": params}))
' "$@") || exit 2

if ! printf '%s' "$payload" | curl -s --max-time 40 -X POST -H "Content-Type: application/json" -d @- "$base/proxy"; then
  echo "could not reach the bot's Slack proxy at $base/proxy" >&2
  exit 1
fi
