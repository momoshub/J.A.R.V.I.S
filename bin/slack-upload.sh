#!/usr/bin/env bash
# Upload a file into a Slack thread, as the bot.
#
#   slack-upload.sh <channel> <thread-ts> <file> [title] [comment]
#
# A sandboxed session has no general `curl` - with the bot token in the
# environment that would be an outbound channel for it. This can only post a
# local file into a thread on Slack, which is what a screenshot needs. The
# thread is required: a file without one lands in the channel root, where the
# person asking cannot see it.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: slack-upload.sh <channel> <thread-ts> <file> [title] [comment]" >&2
  exit 2
fi

channel=$1
thread=$2
file=$3
title=${4:-$(basename "$file")}
comment=${5:-}

[[ "$channel" =~ ^[CDG][A-Z0-9]+$ ]] || { echo "refusing: not a channel id" >&2; exit 2; }
[[ "$thread" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "refusing: not a thread ts" >&2; exit 2; }
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is not set}"

size=$(wc -c < "$file" | tr -d ' ')
ticket=$(curl -sS -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  --data-urlencode "filename=$(basename "$file")" --data-urlencode "length=${size}" \
  https://slack.com/api/files.getUploadURLExternal)
url=$(printf '%s' "$ticket" | jq -r '.upload_url // empty')
id=$(printf '%s' "$ticket" | jq -r '.file_id // empty')
[ -n "$url" ] && [ -n "$id" ] || { echo "upload refused: $(printf '%s' "$ticket" | jq -r '.error // "unknown"')" >&2; exit 1; }

curl -sS -o /dev/null -F "file=@${file}" "$url" || { echo "upload failed" >&2; exit 1; }

files=$(jq -cn --arg id "$id" --arg t "$title" '[{id: $id, title: $t}]')
done_=$(curl -sS -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  --data-urlencode "files=${files}" --data-urlencode "channel_id=${channel}" \
  --data-urlencode "thread_ts=${thread}" --data-urlencode "initial_comment=${comment}" \
  https://slack.com/api/files.completeUploadExternal)
[ "$(printf '%s' "$done_" | jq -r '.ok')" = "true" ] || { echo "upload failed: $(printf '%s' "$done_" | jq -r '.error')" >&2; exit 1; }
echo "$id"
