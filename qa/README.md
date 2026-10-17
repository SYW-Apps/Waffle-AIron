# qa/: the release QA gate, step by step

The policy and the reasons are in `docs/release-qa.md`. This file is the commands. Run everything
from a Git Bash (or Linux) shell at the root of the checkout, on the RC commit.

| Path | What it is |
|---|---|
| `scripts/rc-toolchain.sh` | Packs this checkout and installs it as an isolated toolchain (`wairon`, `ask-claude`). With `--published` it installs a release from npm instead. |
| `scripts/release-checklist.sh` | The deterministic checks: package contents, fresh-home smoke, the upgrade test. |
| `scripts/gen-upgrade-fixture.mjs` | Regenerates the upgrade fixture from a published release. |
| `scripts/pick-scenario.mjs` | Picks a seat's scenario from the release version. |
| `scripts/hosted-changed.sh` | Says whether seat 4 (hosted) is due. |
| `scripts/check-verdict.mjs` | The CI check on a verdict (also useful locally before opening the release pull request). |
| `seats/*.md` | One brief per seat, each with its scenario bank. |
| `verdicts/` | The committed verdicts and their format. |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `QA_VERSION` | (none, set it) | The release version, for example `6.0.0`. |
| `QA_FINDINGS_ROOT` | `C:\wairon-qa` on Windows, `$HOME/wairon-qa` elsewhere | Where findings live. Outside the repository, always. |
| `QA_FINDINGS_DIR` | `$QA_FINDINGS_ROOT/$QA_VERSION` | One folder per release. |
| `QA_MODEL` | `sonnet` | The model for persona agents and the inner assistant. |

```bash
export QA_VERSION=6.0.0
export QA_FINDINGS_ROOT="${QA_FINDINGS_ROOT:-/c/wairon-qa}"      # Windows default; use $HOME/wairon-qa elsewhere
export QA_FINDINGS_DIR="$QA_FINDINGS_ROOT/$QA_VERSION"
export QA_MODEL=sonnet
mkdir -p "$QA_FINDINGS_DIR"
```

## Stage 1: freeze the RC

```bash
git checkout dev && git pull
git rev-parse HEAD            # this is the RC: write it down
npm ci && npm run build
```

From here only QA fixes land on dev. Note that sha: it goes into the verdict.

## Stage 2: automated checks (no LLM)

CI must be green on the RC commit (check the checks on the dev commit). Then, locally:

```bash
qa/scripts/rc-toolchain.sh "$QA_FINDINGS_ROOT/toolchain-rc"
qa/scripts/release-checklist.sh "$QA_FINDINGS_ROOT/toolchain-rc"      # exits non-zero on any FAIL
```

The checklist covers the package contents, a fresh-home smoke (`--version`, `init`, `validate --ci`,
`mcp install`, an MCP `initialize` over stdio) and the v5.1.0 upgrade test, run against the packed RC.
The upgrade test also runs in CI on every pull request. Any FAIL stops the gate: fix it, make a new
RC, start again from stage 1.

## Stage 3: the panel

Pick the scenarios and decide whether seat 4 runs:

```bash
for s in qa/seats/*.md; do echo "$s -> $(node qa/scripts/pick-scenario.mjs "$QA_VERSION" "$s")"; done
qa/scripts/hosted-changed.sh <rc-of-the-last-verdict> <this-rc>        # yes/no for seat 4
```

Seat 1 needs the previous stable as a second toolchain:

```bash
qa/scripts/rc-toolchain.sh "$QA_FINDINGS_ROOT/toolchain-prev" --published latest
```

For each seat, make a NEW folder (never reuse one, never show a seat earlier findings):

```bash
mkdir -p "$QA_FINDINGS_DIR/<seat>"
```

Then start a Sonnet persona agent (a Claude Code subagent, `--model sonnet`) with the seat brief as its
instructions and these values in its task: `QA_SEAT_DIR`, `QA_TOOLCHAIN`, `QA_PREV_TOOLCHAIN` (seat 1),
`QA_SCENARIO` (the line `pick-scenario.mjs` printed), `QA_FINDINGS_DIR`, `QA_MODEL`. The seats do
not depend on each other, so run them in parallel. Each ends with a summary line,
"Ready for release: yes/no, because ...". Their `FINDINGS.md` files stay in `$QA_FINDINGS_DIR`.

## Stage 4: triage and the fix loop

Read each FINDINGS file. For every BLOCKER and MAJOR decide CORE or EDGE yourself (the seat's label is a
suggestion) and write it in `$QA_FINDINGS_DIR/TRIAGE.md`. Fix on dev, then make a new RC (stage 1) and
rerun:

- the checklist (stage 2), always, because it is free;
- only the seats whose finding the fix touched, as a short confirmation: same brief, same scenario,
  a new folder, and a task that says "re-check these findings, then the everyday loop once".

## Stage 5: the verdict, then the release merge

Write `qa/verdicts/$QA_VERSION.md` (format: `qa/verdicts/README.md`). Add every unfixed EDGE major to the
CHANGELOG as a known limitation. Ask the maintainer to run `wairon lock` if the specs moved, and commit
the lock record. Check the pull request locally:

```bash
node qa/scripts/check-verdict.mjs
```

Then open dev -> main with `[major]` or `[minor]` in the merge commit message, as usual. CI's
"Release QA verdict" job re-checks the same thing.
