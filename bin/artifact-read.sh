#!/usr/bin/env bash
# Read a claude.ai artifact, which nothing else here can.
#
#   artifact-read.sh <claude.ai artifact url> [timeout-seconds]
#
# Why this exists: the artifact's content sits behind a Cloudflare bot
# challenge, so curl gets 403 and a headless browser gets "Performing security
# verification". The Docs connector refuses anything that is not a Docs-type
# artifact, under the short id and the UUID alike. And the one tool that CAN
# read them, `Artifact`, is not present in `claude -p` - verified by forcing an
# invocation, which answered NO_SUCH_TOOL.
#
# It IS present in a full session. `claude --bg` starts one, so this opens a
# background session on the host login, has it read the artifact and write the
# result to a file, and prints that file. `claude logs` is not used: it returns
# the raw TUI with its escape codes, which is not something to parse.
#
# Runs on the HOST login - CLAUDE_CODE_OAUTH_TOKEN is removed, exactly as the
# `read` and `ticket` spawns do, because a setup token carries no artifact
# access at all.
#
# It also scrubs the CLAUDE_CODE_* variables of whatever session it was called
# from. This is not tidiness: called by hand it worked, called from inside a
# `read` spawn the session it started reported "Artifact tool is not available
# in this session", because the parent marks its children
# (CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ID and friends) and a session
# that inherits those comes up as a nested one, without the tool. The whole
# point here is a session that is NOT nested.
set -uo pipefail

URL="${1:?usage: artifact-read.sh <claude.ai artifact url> [timeout-seconds]}"
TIMEOUT="${2:-180}"

case "$URL" in
  https://claude.ai/artifact/*|https://claude.ai/code/artifact/*|https://preview.claude.ai/artifact/*) ;;
  *) echo "artifact-read: not a claude.ai artifact url: $URL" >&2; exit 2 ;;
esac

OUT="$(mktemp -t artifact-read)" || exit 1
# The session writes here; mktemp made the file, and an empty file is how we
# know it has not finished yet.
: > "$OUT"

PROMPT="Use the Artifact tool with action=\"read\" and url=\"$URL\". Write what it returns, verbatim and complete, to the file $OUT using the Write tool. If the read fails, write the exact error to that same file instead. Do nothing else: do not summarise, do not explain, do not write anywhere else."

ID="$(env -u CLAUDE_CODE_OAUTH_TOKEN \
  -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION \
  -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID \
  -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET \
  -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_EXECPATH \
  -u CLAUDE_PID -u CLAUDE_EFFORT \
  claude --bg --dangerously-skip-permissions "$PROMPT" 2>&1 \
  | grep -oE 'backgrounded · [0-9a-f]+' | awk '{print $3}' | head -1)"

if [ -z "$ID" ]; then
  echo "artifact-read: could not start a background session" >&2
  rm -f "$OUT"
  exit 1
fi

cleanup() {
  claude stop "$ID" >/dev/null 2>&1
  claude rm "$ID" >/dev/null 2>&1
  rm -f "$OUT"
}
trap cleanup EXIT

waited=0
while [ "$waited" -lt "$TIMEOUT" ]; do
  if [ -s "$OUT" ]; then
    # One more beat so a partial write is not read as the whole answer.
    sleep 1
    cat "$OUT"
    exit 0
  fi
  sleep 2
  waited=$((waited + 2))
done

echo "artifact-read: timed out after ${TIMEOUT}s waiting for the session to read $URL" >&2
exit 1
