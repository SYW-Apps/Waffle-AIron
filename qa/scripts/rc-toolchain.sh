#!/usr/bin/env bash
# Build the release-candidate toolchain the QA panel and the checklist use.
#
#   qa/scripts/rc-toolchain.sh <toolchain-dir>
#   qa/scripts/rc-toolchain.sh <toolchain-dir> --published <version|latest>
#
# Packs this checkout (which must be the RC commit, already built), installs the
# tarball into a clean <toolchain-dir>, and writes two wrappers into <toolchain-dir>/bin.
# With --published it installs that release from the npm registry instead (the
# Upgrader seat's "previous stable"), and skips the pack.
#   wairon      the packed CLI, with every user-level location redirected into the toolchain
#   ask-claude  one turn of a headless Claude Code session in a project folder,
#               on the model in QA_MODEL (default: sonnet)
# See docs/release-qa.md. Run it from a Git Bash / Linux shell.
set -euo pipefail

TC="${1:?usage: rc-toolchain.sh <toolchain-dir> [--published <version|latest>]}"
PUBLISHED=""
if [ "${2:-}" = "--published" ]; then PUBLISHED="${3:?--published needs a version or latest}"; fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Paths the wrappers embed must be native (C:\...) on Windows, plain paths elsewhere.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

EXPECTED=""
if [ -z "$PUBLISHED" ]; then
  [ -f "$REPO/dist/cli/index.js" ] || { echo "dist/ is missing: run 'npm ci && npm run build' on the RC commit first" >&2; exit 1; }
  EXPECTED="$(node "$REPO/dist/cli/index.js" --version)"
fi

mkdir -p "$TC/bin" "$TC/home" "$TC/appdata" "$TC/localappdata" "$TC/cache"
TC="$(cd "$TC" && pwd)"

# The packed tarball is always named wairon-cli-0.0.0-dev.tgz, whatever the build says,
# so an earlier install of "the same version" is silently kept by npm. Remove it first.
SPEC="@wairon/cli@$PUBLISHED"
if [ -z "$PUBLISHED" ]; then
  (cd "$REPO" && npm pack --pack-destination "$TC" >/dev/null 2>&1) || { echo "npm pack failed" >&2; exit 1; }
  SPEC="$TC/wairon-cli-0.0.0-dev.tgz"
  [ -f "$SPEC" ] || { echo "npm pack did not produce $SPEC" >&2; exit 1; }
fi
[ -f "$TC/package.json" ] || echo '{"name":"qa-toolchain","private":true}' > "$TC/package.json"
rm -rf "$TC/node_modules/@wairon/cli"
(cd "$TC" && npm uninstall @wairon/cli --no-audit --no-fund >/dev/null 2>&1 || true)
(cd "$TC" && npm install "$SPEC" --no-audit --no-fund --ignore-scripts >/dev/null)

CLI="$TC/node_modules/@wairon/cli/dist/cli/index.js"
[ -f "$CLI" ] || { echo "installed package has no dist/cli/index.js" >&2; exit 1; }

cat > "$TC/bin/wairon" <<WRAP
#!/usr/bin/env bash
# QA wrapper: the packed RC CLI, with every user-level location inside the toolchain.
export HOME='$(native "$TC/home")' USERPROFILE='$(native "$TC/home")' APPDATA='$(native "$TC/appdata")' LOCALAPPDATA='$(native "$TC/localappdata")' WAIRON_CACHE_DIR='$(native "$TC/cache")'
export CLAUDE_CONFIG_DIR='$(native "$TC/home/.claude")' GEMINI_CONFIG_DIR='$(native "$TC/home/.gemini")'
exec node '$(native "$CLI")' "\$@"
WRAP

cat > "$TC/bin/ask-claude" <<'WRAP'
#!/usr/bin/env bash
# ask-claude <project-dir> <prompt-file> [session-id-to-resume]
# One turn of a headless Claude Code session inside <project-dir>, as a user would run it:
# the RC wairon first on PATH, only the project's own MCP config, no user/global MCP servers.
# Prints the reply and, last, the session id. Model: $QA_MODEL (default sonnet).
set -e
dir="$1"; prompt_file="$2"; resume="${3:-}"
export PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd):$PATH"
cd "$dir"
name=$(basename "$dir"); logdir="$(dirname "$dir")/_logs"; mkdir -p "$logdir"
args=(-p "$(cat "$prompt_file")" --model "${QA_MODEL:-sonnet}" --strict-mcp-config --permission-mode bypassPermissions --output-format json)
[ -f .mcp.json ] && args+=(--mcp-config .mcp.json)
[ -n "$resume" ] && args+=(--resume "$resume")
out=$(claude "${args[@]}" 2>&1) || true
printf '%s\n' "$out" >> "$logdir/$name.jsonl"
printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.result??s);console.log("\n[session_id] "+j.session_id+"  [cost_usd] "+j.total_cost_usd+"  [turns] "+j.num_turns);}catch{console.log(s)}})'
WRAP
chmod +x "$TC/bin/wairon" "$TC/bin/ask-claude"

GOT="$("$TC/bin/wairon" --version)"
if [ -n "$EXPECTED" ] && [ "$GOT" != "$EXPECTED" ]; then
  echo "installed wairon reports '$GOT', this checkout builds '$EXPECTED': the toolchain is stale" >&2
  exit 1
fi
echo "Toolchain ready: wairon $GOT in $TC/bin"
echo "  export PATH=\"$TC/bin:\$PATH\""
