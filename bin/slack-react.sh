#!/usr/bin/env bash
# Add emoji reactions to one Slack message.
#
#   slack-react.sh <channel> <ts> <emoji> [emoji...]
#
# Exists so sandboxed roles can react without being handed a general `curl`.
# It goes through slack-api.sh, so it can only ever reach reactions.add, in the
# channel this turn runs in, and the turn never holds the bot's token.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: slack-react.sh <channel> <ts> <emoji> [emoji...]" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
channel=$1
ts=$2
shift 2

added=0
for name in "$@"; do
  # tolerate :shortcode: as well as bare
  name=${name#:}
  name=${name%:}
  response=$("$here/slack-api.sh" reactions.add "channel=${channel}" "timestamp=${ts}" "name=${name}")
  case "$response" in
    *'"ok":true'*) added=$((added + 1)) ;;
    *) : ;; # already_reacted / invalid_name are expected and not worth failing on
  esac
done

echo "added ${added}/$#"
