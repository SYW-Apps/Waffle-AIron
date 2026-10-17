#!/usr/bin/env bash
# The release QA gate's deterministic checks (no LLM). See docs/release-qa.md, stage 2.
#
#   qa/scripts/release-checklist.sh <toolchain-dir>
#
# <toolchain-dir> is the folder qa/scripts/rc-toolchain.sh built from this checkout.
# Prints PASS or FAIL per check; exits non-zero when any check fails.
set -uo pipefail

TC="${1:?usage: release-checklist.sh <toolchain-dir>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WAIRON="$TC/bin/wairon"
[ -x "$WAIRON" ] || { echo "no $WAIRON: run qa/scripts/rc-toolchain.sh $TC first" >&2; exit 2; }

native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1: $2"; FAILED=1; }

# (a) Package contents: what package.json "files" intends, no more and no less.
check_package() {
  (cd "$REPO" && npm pack --dry-run --json 2>/dev/null) > "$WORK/pack.json" || { fail "a package contents" "npm pack --dry-run failed"; return; }
  node - "$(native "$WORK/pack.json")" "$(native "$REPO")" <<'JS'
const fs = require('fs'), path = require('path');
const [packFile, repo] = process.argv.slice(2);
const packed = JSON.parse(fs.readFileSync(packFile, 'utf8'))[0].files.map((f) => f.path);
const has = (p) => packed.includes(p);
const problems = [];
// What the CLI needs at runtime, and what a user reads.
for (const p of ['dist/cli/index.js', 'dist/index.js', 'dist/webapp.html', 'dist/templates/architect.yaml',
  'dist/templates/canvas/cytoscape.min.js', 'README.md', 'LICENSE', 'package.json', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'docs/cli.md', 'schemas/design-export-2.json']) if (!has(p)) problems.push(`missing ${p}`);
// Every plain entry of package.json "files" that exists must have shipped something.
const files = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).files ?? [];
for (const entry of files.filter((f) => !/[*]/.test(f) && fs.existsSync(path.join(repo, f))))
  if (!packed.some((p) => p === entry || p.startsWith(`${entry}/`))) problems.push(`"files" lists ${entry} but nothing from it shipped`);
// What must never ship: tests, sources, approval records, design notes under investigation, env files.
const forbidden = [/^tests\//, /^src\//, /^web\//, /^qa\//, /^\.wai\//, /(^|\/)lock\.json$/, /^docs\/design\/chained-subsystems/, /^docs\/release-qa\.md$/,/(^|\/)\.env/];
for (const p of packed) if (forbidden.some((re) => re.test(p))) problems.push(`must not ship: ${p}`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log(`${packed.length} files`);
JS
  local rc=$?
  [ $rc -eq 0 ] && pass "a package contents" || fail "a package contents" "see the lines above"
}

# (b) Fresh-home smoke: version, init, validate, MCP registration and a stdio handshake.
check_smoke() {
  local expected got proj="$WORK/smoke"
  expected="$(node "$REPO/dist/cli/index.js" --version)"
  got="$("$WAIRON" --version 2>&1)"
  [ "$got" = "$expected" ] && pass "b1 wairon --version is $got" || { fail "b1 wairon --version" "got '$got', expected '$expected'"; return; }

  mkdir -p "$proj" && cd "$proj" || return
  export PATH="$TC/bin:$PATH"
  "$WAIRON" init --yes > "$WORK/init.log" 2>&1 && [ -d .wai/specs ] && pass "b2 wairon init --yes" || { fail "b2 wairon init --yes" "$(tail -3 "$WORK/init.log")"; return; }
  "$WAIRON" validate --ci > "$WORK/validate.log" 2>&1 && pass "b3 wairon validate --ci on a fresh project" || fail "b3 wairon validate --ci" "$(tail -3 "$WORK/validate.log")"

  rm -f .mcp.json
  "$WAIRON" mcp install --backend claude > "$WORK/mcp.log" 2>&1 && grep -q '"wairon"' .mcp.json 2>/dev/null \
    && pass "b4 wairon mcp install writes .mcp.json" || fail "b4 wairon mcp install" "$(tail -3 "$WORK/mcp.log")"

  # Dependency-free JSON-RPC handshake, as release.yml's verify-npm does: initialize over stdio.
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-checklist","version":"0.0.0"}}}' \
    | timeout 60 "$WAIRON" mcp serve > "$WORK/mcp-init.json" 2> "$WORK/mcp-serve.log" || true
  if grep -q '"protocolVersion"' "$WORK/mcp-init.json" && grep -q '"name":"wairon"' "$WORK/mcp-init.json"; then
    pass "b5 MCP server answers initialize over stdio"
  else
    fail "b5 MCP initialize" "$(head -c 300 "$WORK/mcp-init.json") $(tail -2 "$WORK/mcp-serve.log")"
  fi
  cd "$REPO" || true
}

# (c) The upgrade journey (tests/e2e/upgrade-from-v5.1.0.test.ts) against the PACKED CLI.
check_upgrade() {
  local cli="$TC/node_modules/@wairon/cli/dist/cli/index.js"
  [ -f "$cli" ] || { fail "c upgrade test" "no packed CLI in $TC"; return; }
  if (cd "$REPO" && WAIRON_E2E_CLI="$(native "$cli")" npx vitest run --config vitest.e2e.config.ts tests/e2e/upgrade-from-v5.1.0.test.ts > "$WORK/upgrade.log" 2>&1); then
    pass "c v5.1.0 upgrade test (packed RC CLI)"
  else
    fail "c v5.1.0 upgrade test" "$(tail -15 "$WORK/upgrade.log")"
  fi
}

echo "release checklist for $("$WAIRON" --version 2>&1) at $(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
check_package
check_smoke
check_upgrade
echo
[ "$FAILED" -eq 0 ] && echo "CHECKLIST: PASS" || echo "CHECKLIST: FAIL"
exit "$FAILED"
