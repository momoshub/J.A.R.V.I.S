#!/usr/bin/env bash
# Has anything new been said in this thread?
#
#   slack-wait.sh <channel> <thread-ts> <after-ts> [from-user-id]
#
# Exits 0 as soon as a reply newer than <after-ts> exists (optionally only one
# from a given person), 1 while there is nothing new, and 2 if the thread could
# not be read at all - which a watch counts as an error rather than a "no".
#
# This is what lets the bot wait for an ANSWER: another agent's investigation
# posted back into the thread, a colleague confirming a deploy, Amazon Q
# reporting a build. Without it, waiting on a person or another bot means
# ending the turn and hoping somebody prods it later.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
channel=${1:?channel}
thread=${2:?thread ts}
after=${3:?after ts}
from=${4:-}

out=$("$here/slack-read.sh" replies "$channel" "$thread" 200 2>/dev/null) || exit 2

printf '%s' "$out" | python3 -c '
import json, sys
after = float(sys.argv[1])
who = sys.argv[2] if len(sys.argv) > 2 else ""
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
if not d.get("ok"):
    sys.exit(2)
for m in d.get("messages", []):
    try:
        ts = float(m.get("ts", 0))
    except (TypeError, ValueError):
        continue
    if ts <= after:
        continue
    if who and m.get("user") != who and m.get("bot_id") != who:
        continue
    # Something was said, and it was not the thread parent being re-read.
    print(m.get("text", "")[:300])
    sys.exit(0)
sys.exit(1)
' "$after" "$from"
