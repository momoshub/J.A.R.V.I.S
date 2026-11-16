#!/usr/bin/env bash
# Run a `claude -p` that outlives the turn that started it, and say whether it
# is still alive.
#
#   detached-agent.sh start <dir> <name> <prompt-file> [-- <extra claude args>]
#   detached-agent.sh alive <dir> <name>
#
# `start` launches `claude -p --dangerously-skip-permissions` with the prompt
# file on stdin, in the current directory, and returns at once. It writes
# <dir>/<name>.pid (pid + start time), <name>.log (all output) and, when the
# agent ends, <name>.exit (its exit code). It refuses while <name> is alive.
#
# `alive` exits 0 while that agent is running and 1 once it is gone (or was
# never started), so a watch can fire on its death:
#
#   X/jv watch "<next>" -- sh -c 'test -f <ready> || ! detached-agent.sh alive <dir> <name>'
#
# Why not the Agent tool: a background Agent lives inside the turn's `claude -p`
# and dies with the turn, silently, so a watch on its result file just times
# out hours later. This one is double-forked into its own session, so the
# turn's kill-tree (which walks children) never reaches it, and its pid is on
# disk for a watch to check. The start time is recorded too, so a recycled pid
# never reads as alive.
set -uo pipefail

die() { echo "detached-agent: $*" >&2; exit 2; }

started_at() { ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }

# 0 while the recorded pid is running AND is the process that was started.
is_alive() {
  local file=$1 pid start
  [ -f "$file" ] || return 1
  pid=$(sed -n 1p "$file")
  start=$(sed -n 2p "$file")
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -z "$start" ] || [ "$(started_at "$pid")" = "$start" ]
}

cmd=${1:-}
case "$cmd" in
  start)
    [ $# -ge 4 ] || die "usage: start <dir> <name> <prompt-file> [-- <extra claude args>]"
    dir=$2 name=$3 prompt=$4
    shift 4
    [ "${1:-}" = "--" ] && shift
    case "$name" in *[!A-Za-z0-9._-]*|'') die "name must be [A-Za-z0-9._-]" ;; esac
    [ -f "$prompt" ] || die "no prompt file: $prompt"
    mkdir -p "$dir" || die "cannot create $dir"
    dir=$(cd "$dir" && pwd)
    prompt=$(cd "$(dirname "$prompt")" && pwd)/$(basename "$prompt")
    pidf="$dir/$name.pid" log="$dir/$name.log" exitf="$dir/$name.exit"
    is_alive "$pidf" && die "$name is already running (pid $(sed -n 1p "$pidf"))"
    rm -f "$exitf" "$pidf"
    claude=${CLAUDE_BIN:-claude}
    # A turn marks what it spawns as its child (CLAUDE_CODE_*); a session that
    # inherits those comes up nested. Start it as a top-level one.
    unset_args=()
    while IFS= read -r v; do unset_args+=(-u "$v"); done < <(env | sed -n 's/^\(CLAUDE_CODE_[A-Za-z0-9_]*\)=.*/\1/p;s/^\(CLAUDECODE\)=.*/\1/p')
    # Double fork: the subshell exits at once, so the agent is reparented away
    # from the turn; setsid (via perl, macOS has no setsid) drops its session.
    (
      perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec: $!"' -- \
        env ${unset_args[@]+"${unset_args[@]}"} PROMPT="$prompt" LOG="$log" EXITF="$exitf" bash -c '
          "$@" < "$PROMPT" > "$LOG" 2>&1
          echo $? > "$EXITF"
        ' detached-agent "$claude" -p --dangerously-skip-permissions "$@" \
        < /dev/null > /dev/null 2>&1 &
      echo $! > "$pidf.tmp"
    )
    [ -s "$pidf.tmp" ] || die "launch failed"
    pid=$(cat "$pidf.tmp")
    printf '%s\n%s\n' "$pid" "$(started_at "$pid")" > "$pidf"
    rm -f "$pidf.tmp"
    echo "started $name pid $pid, log $log"
    ;;
  alive)
    [ $# -eq 3 ] || die "usage: alive <dir> <name>"
    is_alive "$2/$3.pid"
    ;;
  *)
    die "usage: start <dir> <name> <prompt-file> [-- <extra claude args>] | alive <dir> <name>"
    ;;
esac
