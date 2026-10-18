_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 02 — Identity and references across roots

**Diagnosis.** A display address derived from mounting is being used as persistent identity. [qualifyId](../../../../../../src/core/specs.ts#L87) interprets the same strings differently according to the outer root's subsystem names. Snapshot lookup then throws away most of that address. Fixing declarations was useful, but reference meaning still lacks a stable provider binding.

**Options.** Strict `super::` paths with overflow errors would be a useful compatibility repair, but keep references coupled to family layout. Globally unique ids on every spec would remove ambiguity but introduce migration and authoring overhead. Stable project identity plus owner-local spec ids and explicit import aliases gives sufficient identity with fewer new fields.

**Recommendation.** Keep existing local ids. Add a committed project identity, distinct from its display name and path. Treat a spec key internally as `(projectId, specKind, localId)`. An exported contract has `(projectId, exportId)`. Validate duplicate identities within a composition, and do not infer identity from matching names.

An illustrative import and call are:

```yaml
# Shipping/.wai/project.yaml — proposed import declaration
projectId: syw.shipping
imports:
  billing:
    project: syw.billing
    snapshot: surfaces/billing.yaml  # relative to .wai/
    digest: "sha256:<contract-digest>"
```

```yaml
# Shipping's component / narrative fragments — proposed reference syntax
dependsOn: ["@billing::invoices"]
# ...
targetComponent: "@billing::invoices"
targetMethod: createInvoice
```

`billing` is Shipping's import alias. It is not Platform's mount id. `invoices` is Billing's public export id, not a search for any component named `invoice_portal`. Bare ids resolve only within the authoring project. Parent-qualified display ids can remain in the UI and legacy APIs, but authoring resolves them to an owner and explicit reference before saving.

The same resolver must handle component references, contracts, trusted links, dispatch targets, and parsed type references. Generic/union types cannot be migrated by replacing only an entire string that happens to equal an id.

Initially reject multiple distinct member instances with the same project identity in one composition. Supporting two versions or deployments of one project later requires an explicit instance/binding identity; a UUID alone does not solve that problem. Copies in different families can retain the same project identity.

**Migration.** Resolve legacy references while their context is available, then produce exact import bindings. Where two pins match or an ancestor hop overflows, stop and report ambiguity. Never convert whichever snapshot happened to be first into a permanent provider choice. Recognize old syntax for a transition period, with diagnostics; do not silently reinterpret it under the new grammar.

**Proof.** Adding a same-named subsystem elsewhere, reordering snapshots, changing a mount alias, relocating a checkout, or switching the entry root does not change the canonical target. Duplicate spellings of the same target normalize to one dependency while retaining distinct narrative call sites.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

2. **Flat grandchildren and declaration shadowing have fixes here.** [qualifyDeclaredId and qualifySubsystemRef](../../../../../../src/core/specs.ts#L129) distinguish declarations from references and handle a same-id realization at arbitrary mount depth. The Payments duplication described in issue 01 is therefore not an outstanding example on this commit. The root-subsystem shortcut for *references*, and the implicit mount/realization merge, remain.

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P5 | Store two snapshots publishing `portal`, with the wrong provider first. Resolve `super::wanted-provider::portal`. The wrong provider wins. | Matching still discards provider identity, even when the reference spells it explicitly. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
