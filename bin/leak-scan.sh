#!/usr/bin/env bash
# Run gitleaks with the repo config plus the private names rule, if available.
# Usage:
#   bin/leak-scan.sh <gitleaks args...>        e.g. bin/leak-scan.sh git . --no-banner
#   bin/leak-scan.sh meta <gitleaks args...>   scan what `gitleaks git` never sees: the
#     commit messages and file paths of the commits selected by $LEAK_SCAN_RANGE
#     (rev-list args, word-split), the ref names in $LEAK_SCAN_REFS and the name and
#     message of the tag objects in $LEAK_SCAN_TAGS
# Every scan runs twice (see "Two passes" below) and fails if either finds something.
# Names rule source, first found: $LEAK_NAMES_TOML (content, used by CI), then
# $LEAK_NAMES_FILE or ~/.jarvis/leak-names.toml. Absent: a notice and the rest still
# runs, unless LEAK_NAMES_REQUIRED=true (CI, where the secret is expected), then a failure.
# LEAK_SCAN_QUIET=true (CI, public log): gitleaks' own output is kept out of the log,
# since a panic on a broken names regex prints the whole list of names in clear.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
names="${LEAK_NAMES_FILE:-$HOME/.jarvis/leak-names.toml}"
if [ -n "${LEAK_NAMES_TOML:-}" ]; then
  printf '%s\n' "$LEAK_NAMES_TOML" > "$tmp/names.toml"
  names="$tmp/names.toml"
fi
# Two passes. "full": gitleaks' default rules plus ours. "bare": only our rules and
# the names rule, without the defaults' global allowlist, which exempts whole file
# types (svg, lockfiles, .gitleaks.toml itself) from every rule.
sed 's/^useDefault = true$/useDefault = false/' "$root/.gitleaks.toml" > "$tmp/bare.toml"
grep -q '^useDefault = false$' "$tmp/bare.toml" || { echo "leak-scan: could not build the no-defaults config" >&2; exit 1; }
full="$root/.gitleaks.toml"
bare="$tmp/bare.toml"
# a names source with no [[rules]] table carrying a regex (whitespace, a bare
# `regex = ...` that would land under [extend]) loads no names rule at all
if [ -f "$names" ] && ! awk '/^[[:space:]]*\[\[rules\]\]/ { r = 1 } r && /^[[:space:]]*regex[[:space:]]*=/ { ok = 1 } END { exit !ok }' "$names"; then
  if [ "${LEAK_NAMES_REQUIRED:-}" = "true" ]; then
    echo "leak-scan: the names rule is required here but its source has no [[rules]] with a regex" >&2
    exit 1
  fi
  echo "leak-scan: the names file ($names) has no [[rules]] with a regex; the private names rule is skipped" >&2
  names=/nonexistent
fi
if [ -f "$names" ]; then
  { printf '[extend]\npath = "%s"\n\n' "$full"; cat "$names"; } > "$tmp/full-names.toml"
  { printf '[extend]\npath = "%s"\n\n' "$bare"; cat "$names"; } > "$tmp/bare-names.toml"
  full="$tmp/full-names.toml"
  bare="$tmp/bare-names.toml"
elif [ "${LEAK_NAMES_REQUIRED:-}" = "true" ]; then
  echo "leak-scan: the names rule is required here but not set (LEAK_NAMES_TOML is empty)" >&2
  exit 1
else
  echo "leak-scan: no names file ($names); the private names rule is skipped" >&2
fi
input=/dev/null
if [ "${1:-}" = "meta" ]; then
  shift
  # shellcheck disable=SC2086
  {
    if [ -n "${LEAK_SCAN_RANGE:-}" ]; then
      git log --format=%B $LEAK_SCAN_RANGE --
      git -c core.quotePath=false log --diff-merges=first-parent --name-only --format= $LEAK_SCAN_RANGE --
    fi
    # branch and tag names are public once pushed
    for r in ${LEAK_SCAN_REFS:-}; do printf '%s\n' "$r"; done
    # an annotated tag: its name line and message (the tagger is an identity, out of scope)
    for t in ${LEAK_SCAN_TAGS:-}; do
      [ "$(git cat-file -t "$t")" = tag ] && git cat-file tag "$t" | grep -vE '^(object|type|tagger) ' || true
    done
  } > "$tmp/meta.txt"
  input="$tmp/meta.txt"
  set -- stdin "$@"
elif [ "${1:-}" = stdin ]; then
  cat > "$tmp/stdin.txt"
  input="$tmp/stdin.txt"
fi
# git mode: a merge commit's own changes (conflict resolutions, edits made while
# merging) show only against its first parent, and a path .gitattributes marks as
# binary shows no diff at all, so both are forced on for every range
if [ "${1:-}" = git ]; then
  fixed=()
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--log-opts" ]; then a="--diff-merges=first-parent --text $a"; fi
    case "$a" in --log-opts=*) a="--log-opts=--diff-merges=first-parent --text ${a#--log-opts=}" ;; esac
    fixed+=("$a")
    prev="$a"
  done
  set -- "${fixed[@]}"
fi
# the bare pass writes its report next to the full one, merged afterwards
report=""
bare_args=()
prev=""
for a in "$@"; do
  if [ "$prev" = "--report-path" ]; then report="$a"; a="$a.bare"; fi
  case "$a" in --report-path=*) report="${a#--report-path=}"; a="$a.bare" ;; esac
  bare_args+=("$a")
  prev="$a"
done
merge_reports() {
  [ -n "$report" ] || return 0
  if [ -f "$report.bare" ]; then
    jq -s 'add | unique_by([.RuleID, .File, .StartLine, .Commit, .Match])' "$report" "$report.bare" > "$tmp/merged.json" 2>/dev/null &&
      mv "$tmp/merged.json" "$report"
    rm -f "$report.bare"
  fi
}
if [ "${LEAK_SCAN_QUIET:-}" != "true" ]; then
  status=0
  gitleaks "$@" --config "$full" < "$input" || status=1
  gitleaks ${bare_args[@]+"${bare_args[@]}"} --config "$bare" < "$input" || status=1
  merge_reports
  exit "$status"
fi
worst=0
for pass in full bare; do
  if [ "$pass" = full ]; then cfg="$full"; args=("$@"); else cfg="$bare"; args=(${bare_args[@]+"${bare_args[@]}"}); fi
  set +e
  gitleaks "${args[@]}" --config "$cfg" --exit-code 99 < "$input" > /dev/null 2> "$tmp/err"
  code=$?
  set -e
  case "$code" in
    0) ;;
    99) [ "$worst" -eq 0 ] && worst=99 ;;
    *) worst=$code ;;
  esac
done
merge_reports
case "$worst" in
  0) echo "leak-scan: no leaks found" >&2 ;;
  99) echo "leak-scan: leaks found" >&2; exit 1 ;;
  *) echo "leak-scan: gitleaks failed (exit $worst), its output is withheld from this log; check the config and the LEAK_NAMES_TOML secret locally" >&2; exit 1 ;;
esac
