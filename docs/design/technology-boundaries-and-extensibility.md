# Technology boundaries & the extension surface

Status: **implemented** (0.2.0)

Origin: a sibling project ("Appenser", an SDD tool for the Make.com low-code
platform) evaluated building on wairon as its foundation and fed back two
architectural needs: explicit *change/isolation* boundaries (technology
leakage, replaceability) alongside wairon's structural boundaries, and a way
to inject platform-specific profiles/rules without forking wairon or bloating
its core.

## Decisions (from design discussion)

1. **Technology is abstracted as a component, not subsystem metadata.** An
   external technology (MySQL, SendGrid, a vendor SDK, a Make datastore) is
   wrapped by an Adapter behind an intent-language interface — inside a
   Repository for persistence, inside a Gateway/boundary component for
   external services. Which technology sits behind the seam is an
   *implementation detail*, so it is declared on **L4**:

   ```yaml
   # customer-store-adapter .implementation.yaml
   technologies: [mysql]
   ```

   Swapping the technology means touching that one L4 (and at most its
   sibling Store); the architecture diagram does not change. This replaces
   the originally proposed `boundary: {kind, exposure, replaceable, ...}`
   block — everything else in that proposal was already covered:
   - "exposure" → existing `publicInterfaces` / public-surface rules
   - "stable contract required" → what L3-first design *is*
   - "replaceable" → implied by Adapter-behind-facade, not asserted
   - "facade enforcement" → existing pattern-composition + stereotype rules
   - `boundaryKind` enum → **rejected**: parallel taxonomy duplicating
     stereotypes/patterns; invites contradictions
   - `swapExamples` → **rejected**: documentation masquerading as validation;
     the leakage rule *is* the swapability check

2. **Leakage rules police the declaration.** All warning severity,
   `lint.allow`-able, no hardcoded vendor lists (only declared tokens are
   policed — zero false authority):
   - `TECH_LEAKAGE` — a declared technology token appearing in any spec
     *outside* the owning component's ownership tree (pattern root + members
     + their contracts/implementations + ancestor subsystems). Covers prose,
     ids, and `dependsOn` references to tech-named components (facade
     bypass). Types are always scanned — tech-specific shapes don't belong
     in the shared type space.
   - `VENDOR_NAME_IN_CONTRACT` — the token in L3 *identifier* surfaces
     (method names, signatures, params, returns, endpoints) of **any**
     interface, including the owning adapter's own: the contract is the swap
     seam, so `insertMySqlRow` is wrong even there. Prose descriptions on
     the owning contract may name the tech (honest documentation).
   - `TECH_ON_LOGIC_COMPONENT` — `technologies` declared on a stereotype
     outside {Adapter, Store, Registry, Index} suggests a missing Adapter
     wrapper.

   Token matching is identifier-aware: the token is normalized
   (`js-yaml` → `jsyaml`), text splits into alphanumeric words, and a word
   containing the normalized token is a hit (`MySqlCustomerStore` hits
   `mysql`). Multi-part tokens additionally match that many consecutive
   words fused, so prose "Google Sheets" hits `google-sheets`. Tokens under
   3 chars are ignored. Common-English-word tech names ("make") will
   false-positive — pick distinctive tokens.

   This is the spec-side hook for future code↔spec conformance checking:
   the same declaration later gates actual imports in code.

3. **Extensibility instead of built-in platform profiles.** Make (and n8n,
   Zapier, …) never enter wairon core. Wairon core defines the rule contract
   and the enforcement engine; profiles and rule packs are data/plugins:
   - `profile` (L1) and `projectType` (project.yaml) become open strings
     validated against *registered* profiles (`UNKNOWN_PROFILE` warning
     names the known set).
   - `.wai/project.yaml` gains `extensions.packs: [...]` — each entry a
     relative YAML file (declarative pack) or a requireable JS module
     (programmatic pack).
   - **Declarative packs** carry data: custom profile definitions
     (`family` opting into built-in stereotype fencing + forbidden/
     discouraged stereotype lists with reasons), and language/platform
     packs (unsupported flow constructs with remodeling guidance, foreign
     builtin markers). Construct display aliases (`switch` → "router")
     deferred to the skill-skin phase — nothing would read them yet.
   - **Programmatic packs** export `rules: SddRule[]` (plus optionally
     profiles/languages) against wairon's exported `SddRule`/`RuleContext`
     API. Loaded via `createRequire` from the project root; CLI and MCP load
     identically, so `sdd_validate_tree` enforces injected rules.
   - Extension rule codes join `knownIssueCodes`, so `lint.allow` and
     `rules.sddRuleSeverity` work on pack rules unchanged.

4. **The flow algebra stays closed.** Packs can *disable* constructs
   (data-driven gating, warning severity — "possible but not clean" is
   guidance, not prohibition) and *alias* them for domain vocabulary, but
   cannot inject step kinds: reachability/region analysis needs a closed
   successor semantics, renumber-relocation walks a fixed jump-field list
   (an unknown step-reference field would silently corrupt narratives on
   insert/delete), and every renderer/skill/conformance consumer must
   understand kinds. ESLint precedent: plugins add rules, never AST node
   types. A construct genuinely inexpressible in the algebra is essentially
   never platform-specific (Make's unfiltered router = parallel fan-out —
   general) and enters core gated-off where unsupported. A `custom` step
   kind bound to closed behavior classes is held in reserve; not needed yet.

5. **Aggregation is dataflow, not control flow.** Make's
   iterator→logic→aggregator is map+fold: `loop forEach` + accumulation
   prose in a body/after step. No aggregate step kind; machine-readable
   dataflow (step inputs/outputs) would be its own designed feature if
   conformance ever wants it.

## Out of scope (deferred)

- Skill/template re-skinning per profile (generated agents speaking
  "scenarios and modules" instead of "source files") — profiles v2
  territory, lands with Appenser's actual pack.
- Async/event step kinds (`dispatchAsync`, `waitForResponse`) — enter core
  when a real narrative needs them. (`parallel` fan-out/join and the `detach`
  call flag entered core 2026-07-19 per §4 — the model review's GPU/robotics/
  backend convergence was the trigger; renderers degrade gracefully until the
  canvas engine renders arms natively.)
- Field-level FK targets, dataflow modeling, declarative custom rules beyond
  profile/language data.
