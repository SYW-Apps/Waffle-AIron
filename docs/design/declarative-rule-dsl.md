# Design: declarative rule assertions for hosted-safe packs

Status: **designed + implemented** (July 2026): `PackAssertionSchema` in
`src/core/extensions.ts`, evaluated by the `declarative-assertions` rule.
This record is the semantic contract for the three v1 kinds.

## 1. Motivation

The extensibility review's sharpest structural finding: **pack distribution
inverts difficulty**. The domains that most need custom doctrine (embedded,
PLC, low-code platforms) are exactly the ones most likely to consume wairon
through the HOSTED server — and the hosted pack-management surface is
deliberately **declarative-only** (no code execution in the multi-tenant
validation path). Today a declarative pack can carry profiles, language
tables, skills, patterns, and guarantee tokens — but **no rules**. Custom
enforcement requires a programmatic JS pack, which requires trusted local
installation. So the users with the least ability to run trusted code get
the least doctrine.

Most pack rules observed in practice are instances of a few closed shapes:
"never depend from X on Y", "every Z must declare F", "Portal endpoints must
look like T". Those need no arbitrary code — they need **parameters**.

## 2. Principle: packs add rule INSTANCES, never rule LOGIC

Same doctrine as the flow algebra (technology-boundaries §4, ESLint
precedent): the *evaluator* for every assertion kind is closed, versioned
core code; a pack contributes **data** that instantiates it. This keeps the
hosted path safe (pure data through the existing declarative-pack API), keeps
findings explainable (every kind has documented semantics), and keeps the
combinatorics sane (renderers/severity/lint.allow machinery see ordinary
issue codes).

A constraint genuinely inexpressible in the assertion kinds is the signal to
either (a) add a new KIND to core — a design decision, like adding a step
type — or (b) write a programmatic pack, which remains fully supported for
trusted local installs.

## 3. Spec surface (DeclarativePackSchema)

```yaml
# pack.yaml
name: make-automation-pack
assertions:
  - kind: forbid-edge
    code: NO-DIRECT-STORE-FANOUT        # pack-local; surfaced as MAKE_AUTOMATION_PACK_NO_DIRECT_STORE_FANOUT
    severity: warning                    # warning (default) | error
    reason: Scenario modules must reach data through the connector facade.
    from: { componentType: [Orchestrator, Specialist] }   # selector
    to:   { componentType: [Store] }                      # selector
    relation: [dependsOn]                # dependsOn | owns (default: both)

  - kind: require-field
    code: REGION-DECLARED
    reason: Every store must pin its data-residency region.
    on: { componentType: [Store] }       # selector for the SPEC the field lives on
    level: implementation                # component | interface | implementation
    field: ext.make.region               # top-level field, or one ext.* path
    values: [eu, us]                     # optional closed value set (strings)

  - kind: endpoint-shape
    code: WEBHOOK-PATHS
    reason: Make webhooks mount under /hooks with kebab-case names.
    on: { componentType: [Portal] }      # selector for the endpoint's component
    transport: [HTTP]                    # optional transport allowlist
    pathPattern: "^/hooks/[a-z0-9-]+$"   # optional anchored regex on path/topic/command
```

### Selectors (closed, v1)

```yaml
{ componentType: [..], profile: [..], id: "glob-*" }
```

All keys optional; absent = match-all; multiple keys AND together.
`profile` matches the component's governing profile
(`ctx.getComponentProfile`), which is how a platform pack scopes its doctrine
to its own subsystems without claiming the whole tree. v1 deliberately has no
NOT/OR combinators — two assertions express OR; NOT is a smell that the
constraint wants to be a stereotype rule.

### Codes and namespacing

A pack declares a short local `code`; core surfaces it as
`<PACK_NAME>_<CODE>` (upper-snake, non-alphanumerics collapsed to `_`) so
two packs never collide, provenance is legible in every finding, and the
codes join `knownIssueCodes` (lint.allow-able, severity-overridable, exactly
like builtin codes). A pack-declared `severity: error` is honored — a pack a
project loads IS that project's doctrine — but the project's
`sddRuleSeverity` still wins, and draft-context downgrades apply (the
assertions are boundary/completeness doctrine, not soundness).

## 4. Evaluation (one core rule)

A single `declarative-assertions` rule in the registry reads the merged
assertion list from `LoadedExtensions.assertions` (append across packs, with
pack provenance) via `RuleContext.ext.assertions` and evaluates:

- **forbid-edge** — for every component matched by `from`, every declared
  edge in `relation` whose target matches `to` raises the finding (message
  carries the pack's `reason`). Purely spec-graph — no code model needed.
- **require-field** — for every spec matched by `on` at `level`, the named
  field must be present (and, when `values` is given, equal one of them).
  Only two field roots are addressable: the spec's own top-level fields and
  `ext.*` (the sanctioned pack data channel) — nothing else, so the DSL can
  never grow into a general query language by accident.
- **endpoint-shape** — for every endpoint on interfaces of components
  matched by `on`: transport must be in `transport` (when given), and the
  transport's address field (path / topic / command / pipe / channel /
  address) must match the anchored `pathPattern` (when given).

Schema validation of the assertions themselves happens at pack load
(`DeclarativePackSchema.parse`) — a malformed assertion is an
`EXTENSION_LOAD_ERROR`, never a silent skip. An unknown `kind` is likewise a
load error: an old wairon must fail loudly rather than silently not-enforce
a newer pack's doctrine.

## 5. What stays out (v1)

- **Narrative-content assertions** (step ordering, required calls) — the
  semantic-edge/antipattern families own narrative judgment; a declarative
  surface over step graphs is its own design.
- **Cross-component counting/cardinality** ("at most one X per subsystem") —
  wants aggregation semantics; defer until a real pack needs it.
- **Type-shape assertions** (field types on entities) — the type system has
  its own rules; ext-field presence covers the pack data channel need.
- **NOT/OR selector combinators** — see above.

## 6. Hosted path

Nothing new needed: declarative packs already flow through the hosted
pack-management API (`checkDeclarativePack` → `DeclarativePackSchema`), and
assertions are plain data inside them. The hosted validation path gains
pack doctrine without ever executing tenant code — the point of the design.
