#!/usr/bin/env bash
# Add emoji reactions to one Slack message.
#
#   slack-react.sh <channel> <ts> <emoji> [emoji...]
#
# Exists so sandboxed roles can react without being handed a general `curl`:
# the bot's token is in this process's environment, so an arbitrary outbound
# request would be an exfiltration channel. This can only ever reach
# reactions.add, and never prints the token.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: slack-react.sh <channel> <ts> <emoji> [emoji...]" >&2
  exit 2
fi

channel=$1
ts=$2
shift 2

: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is not set}"

added=0
for name in "$@"; do
  # tolerate :shortcode: as well as bare
  name=${name#:}
  name=${name%:}
  response=$(curl -s -X POST \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    --data-urlencode "channel=${channel}" \
    --data-urlencode "timestamp=${ts}" \
    --data-urlencode "name=${name}" \
    https://slack.com/api/reactions.add)
  case "$response" in
    *'"ok":true'*) added=$((added + 1)) ;;
    *) : ;; # already_reacted / invalid_name are expected and not worth failing on
  esac
done

echo "added ${added}/$#"
