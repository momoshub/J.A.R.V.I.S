#!/usr/bin/env bash
# Upload a file into a Slack thread, as the bot.
#
#   slack-upload.sh <channel> <thread-ts> <file> [title] [comment]
#
# A sandboxed session has no general `curl`, and no Slack token either: the two
# Slack calls go through slack-api.sh (the bot makes them, and only for the
# channel this turn runs in), and the bytes go straight to the pre-signed upload
# url Slack hands back, which needs no credential. The thread is required: a
# file without one lands in the channel root, where the person asking cannot
# see it.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: slack-upload.sh <channel> <thread-ts> <file> [title] [comment]" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
channel=$1
thread=$2
file=$3
title=${4:-$(basename "$file")}
comment=${5:-}

[[ "$channel" =~ ^[CDG][A-Z0-9]+$ ]] || { echo "refusing: not a channel id" >&2; exit 2; }
[[ "$thread" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "refusing: not a thread ts" >&2; exit 2; }
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }

size=$(wc -c < "$file" | tr -d ' ')
reserved=$("$here/slack-api.sh" files.getUploadURLExternal "filename=$(basename "$file")" "length=${size}") || exit 1
url=$(printf '%s' "$reserved" | jq -r '.upload_url // empty')
id=$(printf '%s' "$reserved" | jq -r '.file_id // empty')
[ -n "$url" ] && [ -n "$id" ] || { echo "upload refused: $(printf '%s' "$reserved" | jq -r '.error // "unknown"')" >&2; exit 1; }

curl -sS -o /dev/null -F "file=@${file}" "$url" || { echo "upload failed" >&2; exit 1; }

files=$(jq -cn --arg id "$id" --arg t "$title" '[{id: $id, title: $t}]')
done_=$("$here/slack-api.sh" files.completeUploadExternal "files=${files}" "channel_id=${channel}" "thread_ts=${thread}" "initial_comment=${comment}") || exit 1
[ "$(printf '%s' "$done_" | jq -r '.ok')" = "true" ] || { echo "upload failed: $(printf '%s' "$done_" | jq -r '.error')" >&2; exit 1; }
echo "$id"
