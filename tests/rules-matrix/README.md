# Rule-matrix test tier

A self-enforcing coverage matrix over the validator's finding codes: **every
code the composed rule sequence can emit must be pinned by at least one
TRIGGERING fixture and one CONTROL fixture** — and adding a new rule (or pack
assertion) without fixtures turns CI red automatically via `meta.test.ts` and
`ratchet.json`.

> Tests validate the rule's DOCUMENTED intent, derived from the rule's
> description and the architecture standard — never from the implementation's
> observed behavior. If a fixture written against the documented intent fails,
> that is a product finding to report, not a test to adjust.

## Layout

```
tests/rules-matrix/
  harness.ts                    defineRuleFixture + the runner/assertions (the contract)
  collect.ts                    auto-collects families/*.fixtures.ts (no manifest to edit)
  matrix.test.ts                one it() per fixture: "[CODE] fires|quiet: <scenario>"
  meta.test.ts                  the coverage invariant against ratchet.json
  ratchet.json                  the explicit not-yet-covered debt (only shrinks)
  fixture-pack/pack.yaml        declarative test pack (namespaced assertion code + guarantee token)
  families/*.fixtures.ts        the fixtures, one file per rule family
```

`npm test` picks all of this up (vitest include `tests/**/*.test.ts`); no extra
command, no build step. Run just this tier with
`npx vitest run tests/rules-matrix/`.

## Writing fixtures

A family file default-exports a non-empty array of fixtures:

```ts
import { defineRuleFixture } from '../harness.js';

export default [
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',        // the finding code under test
    severity: 'error',                    // optional: asserted on the emitted finding
    anchoredTo: 'checkout-portal',        // optional: asserted against the finding's specId
    expectFire: true,                     // true = must fire, false = control (must stay quiet)
    scenario: 'The checkout portal narrative writes an order straight through the order repository facade, skipping the workflow layer.',
    tree: { /* the miniature system, see below */ },
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT',
    expectFire: false,
    reason: 'The write routes through the checkout orchestrator, which is the sanctioned shape.',
    scenario: 'The checkout portal dispatches the order write to the checkout orchestrator, which drives the repository.',
    tree: { /* near-identical tree, defect removed */ },
  }),
];
```

Drop the file in `families/` as `<rule-family>.fixtures.ts` — collection is
automatic; **do not** edit `matrix.test.ts`, and do not share files between
families (one family = one file, so parallel work never conflicts).

### The scenario-realism requirement (hard requirement)

`scenario` is a REQUIRED human sentence describing the realistic architecture
situation ("a billing Portal reads directly from the invoice Store, skipping
the read facade"). Fixtures must read like miniature real systems with
meaningful domain names — `invoice-store`, `shipment-scheduler`,
`carrier-quote-adapter` — **never** `comp1`/`sub-a`/`foo`. The harness rejects
obvious placeholder ids at definition time; reviewers reject the rest.

### The fire+control discipline

Every code gets a PAIR:

- **Fire fixture** (`expectFire: true`): the tree contains exactly the defect
  the rule documents, and the code MUST be among the findings — at the declared
  `severity`, anchored to `anchoredTo`, when those are given.
- **Control fixture** (`expectFire: false`): a NEAR-IDENTICAL tree with the
  defect corrected, and the code MUST be absent. **Controls only guarantee
  their own code's silence** — other codes may legitimately fire on the same
  tree (small trees trip completeness rules like `MISSING_SOURCE_PATH`; that is
  fine and deliberately not asserted on). Never require a clean tree.

State `reason` on controls: why this shape is the sanctioned one.

### The `tree`

A declarative description of a miniature `.wai` spec tree; the harness fills
the boilerplate (schemaVersion, timestamps, derived names/descriptions, status
`complete`) so a fixture states only what its scenario is about:

| Field | Notes |
|---|---|
| `system` | L0 fields over defaults (`name: 'RuleMatrixSystem'`). |
| `subsystems` | `parentSystem` defaults to the system name. |
| `components` | `componentType` defaults to `Orchestrator`; `subsystem` defaults to the single subsystem. |
| `interfaces` | ids must start with `i`; method `description/signature/returns` are defaulted, `name` is required. |
| `implementations` | `contract` defaults to the single interface; narrative steps need a `description` (write real ones). |
| `types` | `kind` defaults to `entity`. |
| `rules` | RulesConfig fragment (severity overrides, naming/complexity/documentation dials, designDepth…). |
| `projectType` | validateSddTree projectType (default `backend`). |
| `packs` | extension-pack refs for the temp project — use `FIXTURE_PACK_DIR` for the test pack. |
| `files` | extra files under the temp root: source files for the code↔spec conformance family, `.wai/surfaces/*.yaml` snapshots, nested subprojects… |
| `scopeSubsystem` / `treatAllAsComplete` | validateSddTree passthrough (scoped runs, the as-complete lock gate). |
| `validateFromSubdir` | bind the VALIDATED root to a subdirectory of the temp root (relative, no `..`) — see below. |

**`validateFromSubdir` — the chained-child seam.** Some findings only exist
when the validated root is itself a CHAINED CHILD of an ancestor project:
`CHAINED_SUBPROJECT_CONTEXT` and `UNVERIFIED_EXTERNAL_REF` come from a
post-rule honesty pass gated on `findChainingParent`, which walks UP the
filesystem from the validated root looking for an ancestor `.wai` project
whose subsystem `projectPath` resolves to that exact root — impossible when
the root is the temp-dir top (its ancestors are bare OS temp dirs). With
`validateFromSubdir`, the tree still materializes at the temp root exactly as
always — so the top-level tree plays the PARENT (declare the mount subsystem
with `projectPath` there) — while the CHILD project is laid down as raw spec
YAML under `tree.files` and validation is bound to its directory. See
`families/references-chained-context.fixtures.ts` for the worked pair.

**`anchoredTo: null`** (vs. omitting it) asserts the emitted finding carries
NO `specId` at all — for tree-level findings like the prepended
`CHAINED_SUBPROJECT_CONTEXT` notice.

Defaults are `complete`-status and depth `narratives`, so both soundness and
expectation codes are live; use spec `status: draft` or `rules.designDepth` when
a scenario is about the draft downgrades or the depth gate themselves.

## How fixtures execute (and why the loader path)

`runRuleFixture` materializes the tree as a REAL temporary `.wai` project
(YAML files on disk) and runs **`validateSddTree()`** against it — the same
entry point the CLI, MCP server, and hosted gate use. That executes the full
composed rule sequence (`composeRuleSequence` semantics: builtins, then the
project's loaded pack rules, lint-allows audit last) *plus* everything around
it: the YAML loaders and zod schemas, the spec cache, extension-pack loading
from project config, severity resolution, lint.allow suppression, draft
downgrades, and the design-depth gate.

Trade-off, stated: this is slightly slower than calling `buildRuleContext`
with in-memory spec objects (~15–25 ms per fixture for temp-dir IO + a full
load) and it means a fixture CAN fail on a loader schema error rather than the
rule under test (the assertion message prints every finding, so this is
obvious when it happens). In exchange, fixtures prove codes fire through the
real product path — a rule that fires in-memory but is starved by the loader
(field dropped by a schema, cache staleness, pack not threaded through) is
exactly the regression this tier exists to catch. At ~320 fixtures the whole
matrix costs a few seconds, so the realism is cheap.

Temp projects are created under the OS temp dir and always removed; the
project-root override and spec cache are restored in `finally`, so fixtures
cannot leak into each other or into other test files (Windows and Linux both).

## The ratchet workflow (`ratchet.json`)

`meta.test.ts` builds the real code universe — `knownIssueCodes` from the rule
registry with the test fixture pack loaded, so `<PACK>_<CODE>` assertion codes
are enforced too — and diffs it against the collected fixtures. The invariant
FAILS when:

1. a code has no triggering fixture **and** no `uncoveredFire` entry
   (⇒ every NEW rule needs fixtures immediately);
2. a ratchet entry's code IS now covered (stale — you must delete the entry,
   so the file only shrinks);
3. a fire-covered code has no control fixture and no `uncoveredControl` entry
   (same one-way mechanics for controls);
4. a ratchet entry names a code that does not exist, or a fixture targets a
   code that does not exist (typo protection in both directions);
5. the lists are unsorted or contain duplicates (keeps every ratchet change a
   minimal one-line-per-code diff).

Together these force `ratchet.json` to be EXACTLY the uncovered set: coverage
can only go up, and re-growing the file is a deliberate, reviewable edit that
means "deleting test coverage" — reject it in review.

**Covering a code** = add the fire+control pair to the right family file, then
delete the code's line(s) from `ratchet.json`. The meta test tells you
precisely which entries to delete when you forget.

## The test fixture pack (`fixture-pack/`)

A small DECLARATIVE pack (`name: ledger-platform`) loaded through the real
project-extension loader whenever a fixture lists it in `tree.packs`:

- a `forbid-edge` assertion (Orchestrator → Adapter, `relation: [dependsOn]`)
  surfaced as **`LEDGER_PLATFORM_DIRECT_VENDOR_CALL`** — the namespaced-code
  fixtures in `families/pack-doctrine.fixtures.ts` prove pack doctrine fires
  and can be satisfied;
- a guarantee token **`ledger-balanced`** — the `UNKNOWN_GUARANTEE` pair proves
  a pack-declared token is accepted while an undeclared one still fires.

`meta.test.ts` asserts the pack loads with zero errors, so its codes can never
silently drop out of the enforced universe.

## Coverage thresholds

`vitest.config.ts` carries `coverage.thresholds`: a global floor just under the
measured baseline, plus a HIGHER floor for `src/core/rules/**` (vitest removes
glob-matched files from the global pool, so the global floor is measured
without the rules directory). The floors move deliberately, by humans —
`autoUpdate` stays off. Thresholds apply only to `npm run test:coverage`;
plain `npm test` runs without coverage.
