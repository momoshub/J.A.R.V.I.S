#!/usr/bin/env bash
# Merge a PR only once its CI is green.
#
#   merge-when-green.sh <pr> [timeout-seconds]
#
# The repo is private on a free plan, so GitHub cannot require a passing check
# before a merge. This is the gate instead: it waits for the checks of the PR's
# current head to appear and finish, and merges (merge commit) only when every
# one passed. A failed check, no checks at all, or the timeout -> no merge,
# exit non-zero. Run it after the last push; a push after it started is not
# what it waited for, so re-run it.
set -uo pipefail

PR=${1:-}
TIMEOUT=${2:-1200}
INTERVAL=${MERGE_POLL_SECONDS:-15}
[ -n "$PR" ] || { echo "usage: merge-when-green.sh <pr> [timeout-seconds]" >&2; exit 2; }

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  out=$(gh pr checks "$PR" 2>&1)
  code=$?
  # 0 all passed, 8 still pending, anything else failed or no checks yet
  if [ "$code" -eq 0 ]; then
    break
  elif [ "$code" -eq 8 ] || printf '%s' "$out" | grep -qi "no checks reported"; then
    :
  else
    echo "CI is not green on PR $PR - not merging:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "CI did not finish on PR $PR within ${TIMEOUT}s - not merging:" >&2
    printf '%s\n' "$out" >&2
    exit 3
  fi
  sleep "$INTERVAL"
done

printf '%s\n' "$out"
gh pr merge "$PR" --merge
