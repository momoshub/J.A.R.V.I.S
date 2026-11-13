#!/usr/bin/env bash
# Download a file shared on Slack, so it can be read.
#
#   slack-file.sh <url_private> [destination]
#
# Slack's url_private is not public: it needs the bot's token, which this turn
# does not hold. The bot fetches it for us (ticketed, Slack file urls only,
# redirects re-checked) and this script writes what comes back. Prints the path
# it wrote.
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: slack-file.sh <url_private> [destination]" >&2
  exit 2
fi

url=$1
dest=${2:-}

case "$url" in
  https://files.slack.com/*|https://*.slack.com/files-pri/*) ;;
  *) echo "refusing: not a Slack file url" >&2; exit 2 ;;
esac

ticket=${JARVIS_SLACK_TICKET:-}
if [ -z "$ticket" ]; then
  echo "no Slack ticket in this turn's environment - I cannot fetch Slack files here" >&2
  exit 3
fi
base=${JARVIS_SLACK_API_URL:-http://127.0.0.1:${DASHBOARD_PORT:-2001}/api/slack}

if [ -z "$dest" ]; then
  name=$(basename "${url%%\?*}")
  dest="${TMPDIR:-/tmp}/slack-${name:-download}"
fi

payload=$(TICKET="$ticket" URL="$url" python3 -c 'import json,os; print(json.dumps({"ticket": os.environ["TICKET"], "url": os.environ["URL"]}))') || exit 2
code=$(printf '%s' "$payload" | curl -sS --max-time 300 -w "%{http_code}" -o "$dest" -X POST -H "Content-Type: application/json" -d @- "$base/file")
status=$?
# curl prints 200 even when the body was cut off after it (exit 18, or the bot aborting an over-size stream): a short file is a failure
if [ "$status" -ne 0 ]; then
  rm -f "$dest"
  echo "download failed (transfer ended early, curl exit $status)" >&2
  exit 1
fi
if [ "$code" != "200" ]; then
  # a refusal comes back as a small JSON error where the file would have been
  reason=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("error",""))' "$dest" 2>/dev/null)
  rm -f "$dest"
  echo "download failed (http $code${reason:+: $reason})" >&2
  exit 1
fi
echo "$dest"
