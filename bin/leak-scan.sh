#!/usr/bin/env bash
# Run gitleaks with the repo config plus the private names rule, if available.
# Usage:
#   bin/leak-scan.sh <gitleaks args...>        e.g. bin/leak-scan.sh git . --no-banner
#   bin/leak-scan.sh meta <gitleaks args...>   scan what `gitleaks git` never sees: the
#     commit messages and file paths of the commits selected by $LEAK_SCAN_RANGE
#     (rev-list args, word-split) and the messages of the tag objects in $LEAK_SCAN_TAGS
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
cfg="$root/.gitleaks.toml"
if [ -f "$names" ]; then
  { printf '[extend]\npath = "%s"\n\n' "$cfg"; cat "$names"; } > "$tmp/config.toml"
  cfg="$tmp/config.toml"
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
      git log --name-only --format= $LEAK_SCAN_RANGE --
    fi
    for t in ${LEAK_SCAN_TAGS:-}; do
      [ "$(git cat-file -t "$t")" = tag ] && git cat-file tag "$t" | sed '1,/^$/d'
    done
  } > "$tmp/meta.txt"
  input="$tmp/meta.txt"
  set -- stdin "$@"
fi
if [ "${LEAK_SCAN_QUIET:-}" != "true" ]; then
  [ "${1:-}" = stdin ] && exec gitleaks "$@" --config "$cfg" < "$input"
  exec gitleaks "$@" --config "$cfg"
fi
set +e
gitleaks "$@" --config "$cfg" --exit-code 99 < "$input" > /dev/null 2> "$tmp/err"
code=$?
set -e
case "$code" in
  0) echo "leak-scan: no leaks found" >&2 ;;
  99) echo "leak-scan: leaks found" >&2; exit 1 ;;
  *) echo "leak-scan: gitleaks failed (exit $code), its output is withheld from this log; check the config and the LEAK_NAMES_TOML secret locally" >&2; exit 1 ;;
esac
