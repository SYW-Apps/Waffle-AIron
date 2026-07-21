#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# next-version.sh — compute the next release version from existing git tags.
#
# Git tags are the SINGLE SOURCE OF TRUTH for versioning. package.json's
# version field is a placeholder (0.0.0-dev) and is deliberately NOT consulted
# here — that is what lets feature branches diverge without version conflicts.
#
# Usage:  bash scripts/next-version.sh <channel> [bump]
#   channel : stable | beta | preview | dev
#   bump    : major | minor | patch   (default: patch)
#             Only applied when a NEW base version is started — while a
#             prerelease line is in progress the counter is simply incremented.
#
# Prints the next version WITHOUT a leading "v", e.g.:
#   stable  -> 5.0.1
#   dev     -> 5.0.1-dev.1   (then 5.0.1-dev.2, 5.0.1-dev.3, ...)
#   beta    -> 5.1.0-beta.1  (with [minor] on a 5.0.x base)
# ---------------------------------------------------------------------------
set -euo pipefail

channel="${1:?channel required (stable|beta|preview|dev)}"
bump="${2:-patch}"

# Highest STABLE tag (vX.Y.Z with no pre-release suffix).
latest_stable="$(git tag -l 'v[0-9]*' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -n1 || true)"
latest_stable="${latest_stable:-v0.0.0}"
stable_base="${latest_stable#v}"

bump_base() { # <base x.y.z> <bump> -> prints bumped base
  local a b c
  IFS='.' read -r a b c <<< "$1"
  case "$2" in
    major) a=$((a + 1)); b=0; c=0 ;;
    minor) b=$((b + 1)); c=0 ;;
    *)     c=$((c + 1)) ;;
  esac
  printf '%s.%s.%s' "$a" "$b" "$c"
}

if [ "$channel" = "stable" ]; then
  bump_base "$stable_base" "$bump"
  exit 0
fi

# Prerelease channel: continue the counter on the same base while that base is
# still ahead of the latest stable; otherwise stable has caught up, so start a
# fresh prerelease line at .1 on the next bumped base.
latest_pre="$(git tag -l "v[0-9]*-${channel}.*" \
  | grep -E "^v[0-9]+\.[0-9]+\.[0-9]+-${channel}\.[0-9]+$" \
  | sort -V | tail -n1 || true)"

if [ -n "$latest_pre" ]; then
  pre_base="$(printf '%s' "$latest_pre" | sed -E "s/^v([0-9]+\.[0-9]+\.[0-9]+)-${channel}\.[0-9]+$/\1/")"
  pre_n="$(printf '%s' "$latest_pre" | sed -E "s/.*-${channel}\.([0-9]+)$/\1/")"
  higher="$(printf '%s\n%s\n' "$stable_base" "$pre_base" | sort -V | tail -n1)"
  if [ "$higher" = "$pre_base" ] && [ "$pre_base" != "$stable_base" ]; then
    printf '%s-%s.%s' "$pre_base" "$channel" "$((pre_n + 1))"
    exit 0
  fi
fi

next_base="$(bump_base "$stable_base" "$bump")"
printf '%s-%s.1' "$next_base" "$channel"
