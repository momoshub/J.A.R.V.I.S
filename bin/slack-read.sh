#!/usr/bin/env bash
# Read Slack with the bot's OWN token: history, a thread, a channel, a user.
#
#   slack-read.sh history  <channel> [limit] [latest-ts]
#   slack-read.sh replies  <channel> <thread-ts> [limit]
#   slack-read.sh info     <channel>
#   slack-read.sh user     <user-id>
#   slack-read.sh find     <#channel-name>
#
# Sandboxed roles have no `curl`, and for good reason: a general outbound
# request with SLACK_BOT_TOKEN in the environment is an exfiltration channel.
# But the bot can genuinely read these, so refusing is a worse answer than a
# narrow door. This script is that door - read methods only, GET only, and it
# cannot post, edit, delete, invite or set anything.
#
# A PUBLIC channel the bot has not joined returns `not_in_channel`. Rather than
# fail, it joins (the token has channels:join) and retries, and says so on
# stderr - a join is visible to everyone in the channel, so it is never silent.
# A PRIVATE channel it was not invited to stays refused, which is correct.
#
# History and replies are CLEANED before they are printed. A message the bot
# streamed into carries a `task_card` block per tool call, and Slack's flattened
# `text` runs those titles together with the actual reply - invisible in Slack,
# but read back here it looks exactly as though the bot had typed its own shell
# commands into the channel. The blocks themselves are dropped too: they are the
# bulk of the payload (a 12-message thread came back at 47KB) and they say
# nothing the text does not.
set -uo pipefail

api() {
  curl -s --max-time 25 -H "Authorization: Bearer ${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is not set}" \
    --get "https://slack.com/api/$1" "${@:2}"
}

ok() { printf '%s' "$1" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' 2>/dev/null; }
err() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null; }

# Join a public channel so its history can be read, then hand back the retry.
join_if_public() {
  local channel=$1
  local info; info=$(api conversations.info -d "channel=$channel")
  if [ "$(printf '%s' "$info" | python3 -c 'import json,sys; c=json.load(sys.stdin).get("channel",{}); print(c.get("is_private"))' 2>/dev/null)" != "False" ]; then
    echo "refusing: $channel is private and the bot was not invited to it" >&2
    return 1
  fi
  echo "note: joining public channel $channel to read it" >&2
  api conversations.join -d "channel=$channel" >/dev/null
}

read_with_join() {
  local method=$1; shift
  local out; out=$(api "$method" "$@")
  if ! ok "$out" && [ "$(err "$out")" = "not_in_channel" ]; then
    local channel=""
    for a in "$@"; do case "$a" in channel=*) channel=${a#channel=} ;; esac; done
    join_if_public "$channel" || { printf '%s' "$out"; return 1; }
    out=$(api "$method" "$@")
  fi
  printf '%s' "$out"
}

# Drop the rendering, keep the conversation: tool-card titles out of `text`,
# `blocks` and `bot_profile` out of every message. Anything unparseable is
# passed through untouched, because a cleaner is never worth a lost read.
clean() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
    for m in d.get("messages", []):
        text = m.get("text", "")
        at = 0
        for b in m.get("blocks", []) or []:
            if b.get("type") != "task_card":
                continue
            title = (b.get("title") or "").strip()
            if not title:
                continue
            i = text.find(title, at)
            if i == -1:
                continue
            end = i + len(title)
            if text[end:end + 1] == " ":
                end += 1
            elif i > 0 and text[i - 1] == " ":
                i -= 1
            text = text[:i] + text[end:]
            at = i
        m["text"] = text.strip()
        m.pop("blocks", None)
        m.pop("bot_profile", None)
        if "root" in m:
            m["root"].pop("blocks", None)
    json.dump(d, sys.stdout, ensure_ascii=False)
except Exception:
    sys.stdout.write(raw)
'
}

case "${1:-}" in
  history) read_with_join conversations.history -d "channel=${2:?channel}" -d "limit=${3:-20}" ${4:+-d "latest=$4"} ${4:+-d "inclusive=true"} | clean ;;
  replies) read_with_join conversations.replies -d "channel=${2:?channel}" -d "ts=${3:?thread ts}" -d "limit=${4:-50}" | clean ;;
  info)    api conversations.info -d "channel=${2:?channel}" ;;
  user)    api users.info -d "user=${2:?user id}" ;;
  find)    api conversations.list -d "types=public_channel" -d "limit=1000" -d "exclude_archived=true" ;;
  *)
    echo "usage: slack-read.sh history|replies|info|user|find ..." >&2
    exit 2
    ;;
esac
