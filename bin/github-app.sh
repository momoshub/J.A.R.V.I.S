#!/usr/bin/env bash
# Act on GitHub AS THE GITHUB APP (not as a person).
#
#   github-app.sh pr-create <owner/repo> --head <branch> --base <branch> --title <t> --body-file <f> [--draft]
#   github-app.sh comment <owner/repo> <number> <body-file>
#   github-app.sh review <owner/repo> <number> <APPROVE|REQUEST_CHANGES|COMMENT> [body-file]
#   github-app.sh pr-edit <owner/repo> <number> [--title <t>] [--body-file <f>]
#   github-app.sh pr-close <owner/repo> <number>
#   github-app.sh pr-reopen <owner/repo> <number>
#   github-app.sh pr-merge <owner/repo> <number> [--method merge|squash|rebase]
#   github-app.sh labels-add <owner/repo> <number> <label>...
#   github-app.sh labels-remove <owner/repo> <number> <label>...
#   github-app.sh reviewers-request <owner/repo> <number> <login|team:slug>...
#   github-app.sh git <owner/repo> <local-repo-dir> -- <git args>...
#   github-app.sh push <owner/repo> <local-repo-dir> <branch> [--force-with-lease]
#
# The PR actions print GitHub's JSON answer wrapped as {"ok":true,"url":...,
# "number":...,"github":{...}}, or {"ok":false,"error":"..."} (exit 1).
#
# git runs `git -C <dir> <args>` AS THE APP: commits and cherry-picks are
# committed by `<slug>[bot]` (<id>+<slug>[bot]@users.noreply.github.com, no GPG
# signing), and fetch/push/clone-style calls to github.com are authenticated
# with a fresh installation token. git's own output and exit code come back
# as-is. push is `git push` of one branch to the remote of <dir> that points at
# <owner/repo> (ssh remotes are read as https), e.g.
#   github-app.sh git o/r /path/to/clone -- commit -m "fix: x"
#   github-app.sh push o/r /path/to/clone fix/x --force-with-lease
# The token lives only in that one git process's environment (GIT_CONFIG_*
# http.extraheader): never in a remote url, .git/config, argv or a file. A
# cherry-picked commit keeps its original author (add --reset-author to
# change it).
#
# The ticket comes from JARVIS_RUN_TICKET in this process's environment, never
# from an argument. The bot resolves it to whoever this turn runs as and only
# acts if that person is an admin or the owner. The app's private key never
# reaches the turn; the bot holds it. (For a plain answer on the issue a GitHub
# call came from, github-app-comment.sh needs no role.)
#
# Endpoint: GITHUB_APP_ACTION_URL, else the loopback dashboard on
# DASHBOARD_PORT (default 2001).
set -uo pipefail

if [ "$#" -lt 2 ]; then
  sed -n '3,30p' "$0" >&2
  exit 2
fi

ticket=${JARVIS_RUN_TICKET:-}
if [ -z "$ticket" ]; then
  echo "no ticket in this turn's environment - I cannot act on GitHub here" >&2
  exit 3
fi

endpoint=${GITHUB_APP_ACTION_URL:-http://127.0.0.1:${DASHBOARD_PORT:-2001}/api/github-app/action}

if [ "$1" = git ] || [ "$1" = push ]; then
  mode=$1
  repo=$2
  shift 2
  if [ "$#" -lt 1 ]; then
    echo "usage: github-app.sh $mode <owner/repo> <local-repo-dir> ..." >&2
    exit 2
  fi
  dir=$1
  shift
  if [ ! -d "$dir" ]; then
    echo "not a directory: $dir" >&2
    exit 2
  fi
  if [ "$mode" = git ]; then
    [ "${1:-}" = "--" ] && shift
    if [ "$#" -lt 1 ]; then
      echo "git needs git arguments after the directory, e.g. -- commit -m msg" >&2
      exit 2
    fi
  else
    if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
      echo "usage: github-app.sh push <owner/repo> <local-repo-dir> <branch> [--force-with-lease]" >&2
      exit 2
    fi
    branch=$1
    lease=
    if [ "$#" -eq 2 ]; then
      if [ "$2" != "--force-with-lease" ]; then
        echo "unexpected argument $2" >&2
        exit 2
      fi
      lease=1
    fi
    if ! git -C "$dir" check-ref-format "refs/heads/$branch" 2>/dev/null; then
      echo "not a branch name: $branch" >&2
      exit 2
    fi
    # The remote of this clone that points at <owner/repo>, whatever its url form.
    remote=
    while IFS= read -r name; do
      url=$(git -C "$dir" config --get "remote.$name.url" 2>/dev/null) || continue
      norm=$(printf '%s' "$url" | tr 'A-Z' 'a-z' | sed -e 's/\.git$//' -e 's#/*$##')
      want=$(printf '%s' "$repo" | tr 'A-Z' 'a-z')
      case "$norm" in
        *github.com/"$want" | *github.com:"$want") remote=$name; break ;;
      esac
    done < <(git -C "$dir" remote)
    if [ -z "$remote" ]; then
      echo "no remote of $dir points at $repo" >&2
      exit 2
    fi
    set -- push
    [ -n "$lease" ] && set -- "$@" "--force-with-lease=refs/heads/$branch"
    set -- "$@" "$remote" "refs/heads/$branch:refs/heads/$branch"
  fi

  auth_payload=$(TICKET="$ticket" REPO="$repo" python3 -c 'import json,os
print(json.dumps({"ticket": os.environ["TICKET"], "action": "git-auth", "repo": os.environ["REPO"]}))') || exit 2
  auth_response=$(curl -s -X POST -H "Content-Type: application/json" -d "$auth_payload" "$endpoint")
  # Line 1 name, 2 email, 3 the Authorization header value. Never printed.
  auth=$(printf '%s' "$auth_response" | python3 -c 'import base64,json,sys
try:
    r = json.load(sys.stdin)
except Exception:
    print("no usable answer from the bot", file=sys.stderr)
    sys.exit(1)
g = r.get("github") if r.get("ok") else None
if not isinstance(g, dict) or not g.get("token"):
    print(r.get("error") or "the bot gave no git credentials", file=sys.stderr)
    sys.exit(1)
print(g["name"])
print(g["email"])
print("AUTHORIZATION: basic " + base64.b64encode(("x-access-token:" + g["token"]).encode()).decode())') || exit 1
  bot_name=$(printf '%s\n' "$auth" | sed -n 1p)
  bot_email=$(printf '%s\n' "$auth" | sed -n 2p)
  header=$(printf '%s\n' "$auth" | sed -n 3p)

  # The credential rides in this one process's environment only (config via
  # GIT_CONFIG_*, so it is not on argv and not written anywhere). An empty
  # credential.helper stops a keychain helper from storing it.
  GIT_TERMINAL_PROMPT=0 \
    GIT_AUTHOR_NAME=$bot_name GIT_AUTHOR_EMAIL=$bot_email \
    GIT_COMMITTER_NAME=$bot_name GIT_COMMITTER_EMAIL=$bot_email \
    GIT_CONFIG_COUNT=8 \
    GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0=$header \
    GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= \
    GIT_CONFIG_KEY_2=user.name GIT_CONFIG_VALUE_2=$bot_name \
    GIT_CONFIG_KEY_3=user.email GIT_CONFIG_VALUE_3=$bot_email \
    GIT_CONFIG_KEY_4=commit.gpgsign GIT_CONFIG_VALUE_4=false \
    GIT_CONFIG_KEY_5=tag.gpgsign GIT_CONFIG_VALUE_5=false \
    GIT_CONFIG_KEY_6=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_6=git@github.com: \
    GIT_CONFIG_KEY_7=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_7=ssh://git@github.com/ \
    git -C "$dir" "$@"
  exit $?
fi
payload=$(TICKET="$ticket" python3 - "$@" <<'PY'
import json, os, sys

args = sys.argv[1:]
action, repo, rest = args[0], args[1], args[2:]


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        die("cannot read " + path)


def number():
    if not rest or not rest[0].isdigit():
        die(action + " needs a pull request / issue number")
    return int(rest.pop(0))


def flags(known, switches=()):
    out = {}
    while rest:
        a = rest.pop(0)
        if a in switches:
            out[a] = True
        elif a in known and rest:
            out[a] = rest.pop(0)
        else:
            die("unexpected argument " + a)
    return out


p = {"ticket": os.environ["TICKET"], "action": action, "repo": repo}
if action == "pr-create":
    f = flags(["--head", "--base", "--title", "--body-file"], ["--draft"])
    p.update(head=f.get("--head", ""), base=f.get("--base", ""), title=f.get("--title", ""), draft=bool(f.get("--draft")))
    if "--body-file" in f:
        p["body"] = read(f["--body-file"])
elif action == "comment":
    p["number"] = number()
    if len(rest) != 1:
        die("comment needs <body-file>")
    p["body"] = read(rest[0])
elif action == "review":
    p["number"] = number()
    if not rest:
        die("review needs APPROVE, REQUEST_CHANGES or COMMENT")
    p["event"] = rest.pop(0)
    if rest:
        p["body"] = read(rest.pop(0))
    if rest:
        die("too many arguments")
elif action == "pr-edit":
    p["number"] = number()
    f = flags(["--title", "--body-file"])
    if "--title" in f:
        p["title"] = f["--title"]
    if "--body-file" in f:
        p["body"] = read(f["--body-file"])
elif action in ("pr-close", "pr-reopen"):
    p["number"] = number()
    if rest:
        die("too many arguments")
elif action == "pr-merge":
    p["number"] = number()
    f = flags(["--method"])
    if "--method" in f:
        p["method"] = f["--method"]
elif action in ("labels-add", "labels-remove"):
    p["number"] = number()
    p["labels"] = rest
elif action == "reviewers-request":
    p["number"] = number()
    p["reviewers"] = rest
else:
    die("unknown action " + action)
print(json.dumps(p))
PY
) || exit 2

response=$(curl -s -X POST -H "Content-Type: application/json" -d "$payload" "$endpoint")
printf '%s\n' "$response"
printf '%s' "$response" | python3 -c 'import json,sys
try: sys.exit(0 if json.load(sys.stdin).get("ok") else 1)
except Exception: sys.exit(1)'
