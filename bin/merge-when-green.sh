#!/usr/bin/env bash
# Merge a PR only once CI is green on the exact commit you pushed.
#
#   merge-when-green.sh <pr> [timeout-seconds]     (run from the PR's worktree)
#
# The repo is private on a free plan, so GitHub cannot require a passing check
# before a merge. This is the gate instead. It takes the commit to merge from
# `git rev-parse HEAD` (or MERGE_HEAD_SHA), waits until the PR's head IS that
# commit, waits for the CI check (REQUIRED_CHECK, default `checks`) to appear -
# a fast third-party check passing alone is not CI - and for every check to
# finish, then merges (merge commit) pinned to that commit, so a push that
# lands meanwhile is never merged unchecked. Any failed or cancelled check, or
# the timeout -> no merge, exit non-zero.
#
# The default timeout stays under the 10 minute ceiling of a foreground tool
# call; give that call a timeout to match. Exit 3 means "not finished yet":
# run it again.
set -uo pipefail

PR=${1:-}
TIMEOUT=${2:-540}
INTERVAL=${MERGE_POLL_SECONDS:-15}
REQUIRED=${REQUIRED_CHECK:-checks}
[ -n "$PR" ] || { echo "usage: merge-when-green.sh <pr> [timeout-seconds]" >&2; exit 2; }
SHA=${MERGE_HEAD_SHA:-$(git rev-parse HEAD 2>/dev/null)}
[ -n "$SHA" ] || { echo "cannot tell which commit to merge: run it from the PR's worktree" >&2; exit 2; }

deadline=$(( $(date +%s) + TIMEOUT ))
why=""
while :; do
  head=$(gh pr view "$PR" --json headRefOid -q .headRefOid 2>/dev/null)
  if [ "$head" != "$SHA" ]; then
    why="PR head is ${head:-unknown}, waiting for $SHA (pushed?)"
  else
    out=$(gh pr checks "$PR" --json name,bucket 2>&1)
    if ! printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1; then
      if printf '%s' "$out" | grep -qi "no checks reported"; then
        why="no checks reported yet"
      else
        echo "cannot read the checks of PR $PR - not merging:" >&2
        printf '%s\n' "$out" >&2
        exit 1
      fi
    else
      bad=$(printf '%s' "$out" | jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | "\(.name): \(.bucket)"')
      if [ -n "$bad" ]; then
        echo "CI is not green on PR $PR - not merging:" >&2
        printf '%s\n' "$bad" >&2
        exit 1
      fi
      if ! printf '%s' "$out" | jq -e --arg n "$REQUIRED" 'any(.[]; .name == $n)' >/dev/null; then
        why="check '$REQUIRED' has not appeared yet"
      elif printf '%s' "$out" | jq -e 'any(.[]; .bucket == "pending")' >/dev/null; then
        why="checks still running"
      else
        printf '%s' "$out" | jq -r '.[] | "\(.name): \(.bucket)"'
        exec gh pr merge "$PR" --merge --match-head-commit "$SHA"
      fi
    fi
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "not merged within ${TIMEOUT}s: $why. run it again" >&2
    exit 3
  fi
  sleep "$INTERVAL"
done
