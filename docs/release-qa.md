# Release QA gate

Every release goes through this gate before dev is merged into main. It is the old "user trials"
turned into one repeatable procedure: a fixed panel of LLM personas that use wairon as a stranger
would, plus a short list of checks that need no LLM at all. The commands are in `qa/README.md`; this
page is the policy and the reasons.

It is a maintainer document.

## When it runs

Before every dev -> main release merge, the one whose merge commit carries `[major]` or `[minor]`.
Nothing else triggers it. CI enforces the end of it: a pull request into main fails the "Release QA
verdict" job unless a passing verdict covers the code being merged (stage 5).

## The stages

1. **Freeze a release candidate (RC).** The RC is one commit on dev. After it, only QA fixes land on
   dev; features wait. Build it (`npm ci && npm run build`) and write its full sha down: the verdict
   names it.
2. **Automated checks (free, no LLM).** All must be green before any LLM is started:
   - CI green on the RC commit (typecheck, unit tests, e2e journeys, conformance, lock-check).
   - `qa/scripts/release-checklist.sh` against the packed RC:
     the **package-contents check** (the runtime files are in the tarball; tests, sources, lock records
     and unfinished design notes are not), the **fresh-install smoke** (`--version`, `init`,
     `validate --ci`, `mcp install`, an MCP `initialize` over stdio, in a fresh home), and the
     **upgrade test** (below).
   - The **v5.1.0 upgrade test** (`tests/e2e/upgrade-from-v5.1.0.test.ts`) replays the CHANGELOG's
     upgrade steps on a project the published v5.1.0 wrote and locked, with no LLM. It also runs in CI
     on every pull request, so a CHANGELOG step that stops working is found when the code changes,
     not at release time. The checklist runs it against the packed RC, which is what users get.
3. **The QA panel run.** The fixed seats below, in parallel, each in a new folder.
4. **Triage and the fix loop.** The maintainer classifies every BLOCKER and MAJOR (CORE or EDGE),
   fixes what the exit criteria require, and every fix makes a **new RC**. After a fix: the free
   checks rerun in full, and only the seats whose finding the fix touched rerun, as a short
   confirmation (their findings, then the everyday loop once). Untouched seats keep their result.
5. **The verdict file, then the release merge.** Write `qa/verdicts/<version>.md`
   (format in `qa/verdicts/README.md`), add the unfixed edge majors to the CHANGELOG as known
   limitations, take the lock if the specs moved, and open dev -> main.

## CORE and EDGE

The same split the trial rounds used. Classify honestly: do not inflate an edge into core, and do not
hide a core problem as edge.

- **CORE** is the everyday loop: design, validate, approval (`lock`, `lock-check`), implementation
  from briefs, the code-vs-design gate on honest and dishonest code, renames, upgrades, and the
  externals and members a normal team uses. For the hosted seat, the everyday loop of a hosted team:
  setup from the docs, sign-in, a shared design, roles, tokens, approval, restart.
- **EDGE** is rare shapes, exotic migrations, export-format details, deliberate tampering and
  concurrency.

Severities are BLOCKER (could not proceed, data lost, or a wrong result presented as right), MAJOR
(confusing or misleading, a doc that does not match, a step a normal user gets wrong, the assistant
led astray by the tool's own guide), MINOR and GOOD. Only BLOCKER and MAJOR gate the release.

## Exit criteria

The release may merge when all of these hold on the final RC:

- 0 BLOCKER and 0 CORE MAJOR, in every seat that ran.
- Every EDGE MAJOR is either fixed or listed in the CHANGELOG as a known limitation (and in the
  verdict's `knownLimitations`).
- Every automated check is green.

## The panel

The seats are the same every release, so results compare across releases. Each run starts fresh: the
persona is given no earlier findings and no memory, and works in a new folder. A persona is a Sonnet
subagent playing a real developer who learns wairon only from the docs shipped in the package; its
"AI assistant" is a headless Claude Code session driven through the `ask-claude` wrapper. The briefs are
`qa/seats/*.md`.

| Seat | Who | What it proves |
|---|---|---|
| 1. Upgrader | Builds a realistic project with the published previous stable (`@wairon/cli@latest`, today 5.1.0), then upgrades to the RC following ONLY the CHANGELOG's upgrade steps. | The upgrade path a real team takes works as written, and the everyday loop survives it. |
| 2. Newcomer | Has never seen wairon; works from the README and shipped docs only. Builds a small app end to end: design, validate, lock, implement one component from a brief, change the design, re-lock. | The first hour is possible without insider knowledge. |
| 3. Stress and adversarial | A multi-project family (members plus an external), one Python service. Writes code that deliberately disagrees with its design. | The code-vs-design gate catches ordinary mismatches in more than one language, and does not cry wolf. |
| 4. Hosted operator (conditional) | Sets up the hosted server with the web UI, two users, tokens and a shared project. | The hosted setup works from the docs, and roles and tokens do what they say. |

Seat 4 runs when the release changes the hosted server since the last verdict (`src/server/**`,
`web/**`, or any spec of the hosted subsystem; `qa/scripts/hosted-changed.sh` answers this), or when the
maintainer marks hosted as in scope. Otherwise the verdict says it did not run.

### Scenarios rotate deterministically

Each seat has a small bank of scenarios (3 or 4 app ideas) in its brief. The scenario is chosen from
the release version: `(major + minor + patch) mod bank size`, with `qa/scripts/pick-scenario.mjs`
doing the arithmetic. Why not always the same app? A panel that builds the same warehouse API every
release stops finding new things: fixes get tuned to it. Why not random? Then a regression cannot be
told from a different roll of the dice, and a rerun after a fix could land on another app. A rule
based on the version gives both: the same release always gets the same scenarios (so a rerun after a
fix is comparable), and consecutive releases walk the bank.

## Cost policy

Subscription usage is the constraint, so:

- Persona agents and the inner assistant sessions run on **Sonnet** (`--model sonnet`; the `ask-claude`
  wrapper reads `QA_MODEL`, default `sonnet`). Nothing runs on a more expensive model unless the
  maintainer sets `QA_MODEL` on purpose.
- Each seat is capped at about **12 inner assistant turns**, written into its brief.
- **Everything deterministic is a script or a CI test, not an LLM**: the package check, the smoke, the
  upgrade replay, the scenario pick, the hosted-changed test and the verdict check.
- After a fix, **only the affected seats rerun**, and only as a confirmation.

## Where findings live

The repository is public. Seat FINDINGS files, triage notes and toolchains live in a local folder
outside it: `C:\wairon-qa\<version>\` by default on Windows, `$HOME/wairon-qa/<version>` elsewhere,
set with `QA_FINDINGS_ROOT` / `QA_FINDINGS_DIR`. Findings can describe broken behaviour in detail; the
public record is the verdict only: counts, scenario names, and one line per known limitation. The seat
briefs tell personas to describe symptoms and not write ways to abuse a deployment, but triage is the
maintainer's job: nothing from a FINDINGS file is copied into the repository without being read first.
Fixes and the CHANGELOG describe behaviour, not the tricks that exposed it.

## The verdict and the CI check

`qa/verdicts/<version>.md` records the RC sha, each seat's scenario, model and counts, the checklist
result and the known limitations. The "Release QA verdict" job (`.github/workflows/ci.yml`, pull
requests into main only) fails unless some verdict in `qa/verdicts/` has all of:

1. `result: PASS`;
2. its `rc` commit is an ancestor of the pull request head;
3. no change under `src/`, `web/`, `sdk/`, `schemas/`, a `templates` folder, `package.json` or
   `package-lock.json` between `rc` and the head.

Lock records, docs, the CHANGELOG, `qa/` and regenerated `.wai/` context may change after the RC, and
so may the release bot's version stamp (`chore: release v…` commits that change only
`src/config/defaults.ts`), which every merge into dev produces. Anything else means the QA has to run again on a new RC. To make the job a hard gate, add it to the
required checks of the main branch protection (a repository setting, not something this repository can
change for itself).

## Regenerating the upgrade fixture

The fixture is the previous stable's own output, so it is regenerated from each new stable:
`node qa/scripts/gen-upgrade-fixture.mjs --version <previous stable> --out tests/fixtures/upgrade-v<previous stable>`,
then point the test at the new folder and rewrite its steps from the new CHANGELOG section. See
`tests/fixtures/upgrade-v5.1.0/GENERATE.md`.
