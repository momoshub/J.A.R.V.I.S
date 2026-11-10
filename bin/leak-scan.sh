#!/usr/bin/env bash
# Run gitleaks with the repo config plus the private names rule, if available.
# Usage: bin/leak-scan.sh <gitleaks args...>   e.g. bin/leak-scan.sh git . --no-banner
# Names rule source, first found: $LEAK_NAMES_TOML (content, used by CI), then
# $LEAK_NAMES_FILE or ~/.jarvis/leak-names.toml. Absent: a notice, the rest still runs.
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
else
  echo "leak-scan: no names file ($names); the private names rule is skipped" >&2
fi
gitleaks "$@" --config "$cfg"
