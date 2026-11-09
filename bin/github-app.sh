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
#
# Prints GitHub's JSON answer wrapped as {"ok":true,"url":...,"number":...,
# "github":{...}}, or {"ok":false,"error":"..."} (exit 1).
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
  sed -n '3,13p' "$0" >&2
  exit 2
fi

ticket=${JARVIS_RUN_TICKET:-}
if [ -z "$ticket" ]; then
  echo "no ticket in this turn's environment - I cannot act on GitHub here" >&2
  exit 3
fi

endpoint=${GITHUB_APP_ACTION_URL:-http://127.0.0.1:${DASHBOARD_PORT:-2001}/api/github-app/action}
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
