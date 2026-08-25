#!/usr/bin/env bash
# Download a file shared on Slack, so it can be read.
#
#   slack-file.sh <url_private> [destination]
#
# Slack's url_private is not public: it needs the bot token, which lives in this
# process's environment. This exists so a sandboxed session can fetch an
# attachment without being handed a general `curl`. Prints the path it wrote.
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

: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is not set}"

if [ -z "$dest" ]; then
  name=$(basename "${url%%\?*}")
  dest="${TMPDIR:-/tmp}/slack-${name:-download}"
fi

code=$(curl -sS -L -w "%{http_code}" -o "$dest" -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" "$url")
if [ "$code" != "200" ]; then
  echo "download failed (http $code)" >&2
  exit 1
fi
echo "$dest"
