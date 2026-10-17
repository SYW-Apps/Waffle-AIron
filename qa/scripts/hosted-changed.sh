#!/usr/bin/env bash
# Does the hosted server differ between two commits? (Decides whether seat 4 runs.)
#
#   qa/scripts/hosted-changed.sh <last-verdict-rc> <this-rc>
#
# Prints "yes" and the first few files when anything under src/server/ or web/ moved, or
# any spec of the sdd_host subsystem; prints "no" otherwise. Exit 0 either way.
set -euo pipefail
FROM="${1:?usage: hosted-changed.sh <last-verdict-rc> <this-rc>}"
TO="${2:?usage: hosted-changed.sh <last-verdict-rc> <this-rc>}"

hits=()
while IFS= read -r f; do
  case "$f" in
    src/server/*|web/*|.wai/specs/subsystems/sdd_host.yaml) hits+=("$f") ;;
    .wai/specs/*)
      # A hosted component, interface, implementation or type names its subsystem.
      if git show "$TO:$f" 2>/dev/null | grep -q 'subsystem: sdd_host' \
        || git show "$FROM:$f" 2>/dev/null | grep -q 'subsystem: sdd_host'; then hits+=("$f"); fi ;;
  esac
done < <(git diff --name-only "$FROM" "$TO")

if [ "${#hits[@]}" -gt 0 ]; then
  echo "yes (${#hits[@]} files, e.g. ${hits[0]})"
else
  echo "no"
fi
