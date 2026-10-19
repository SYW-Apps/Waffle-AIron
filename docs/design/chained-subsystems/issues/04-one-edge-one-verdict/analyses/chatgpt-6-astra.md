_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 04 — One edge, one verdict

**Diagnosis.** Reference resolution and adjudication are mixed. The fallback uses the presence or absence of issue codes as evidence that a target resolved. It can re-evaluate an entire scoped subtree after one unresolved reference, as P6 demonstrates. Its intermediate merge key is only `(code, specId)`, so it cannot distinguish two different edges or call sites in the same spec.

**Options.** Always preferring a reachable live tree fixes some stale-pin cases but violates location independence. Taking the most severe finding from every reachable root is conservative in some cases, but combines different evidence and policies and still cannot prove resolution. Explicit input selection plus structured resolution and assessment separates the questions correctly.

**Recommendation.** Define two useful assessments:

1. **Project assessment:** own specs and code, own policy and approval context, exact imported contract digests. This is the standalone reproducible gate.
2. **Composition assessment:** the selected member revisions, their owner assessments, actual provider exports, declared bindings, and composition policies. This is what validates the proposed family together.

A normal standalone run should not search ancestor directories. A family run should not merely repeat the current flatten-and-validate operation. Both use the same canonical resolver and boundary-checking logic with explicitly different inputs when appropriate.

The resolver should return a structured result before any severity or suppression handling:

```text
resolved(owner, export/spec, selectedDigest, facts)
missing(declaredProvider, requestedExport)
ambiguous(candidates)
unavailable(requiredInput)
forbidden(target)
```

A diagnostic then carries the owner, source field or call site, canonical target, rule identity/version, effective policy, input digest, and check coverage. Failure to emit a diagnostic is not proof that resolution succeeded. Suppression affects reporting or gate treatment after the resolution fact exists.

For a family selecting Billing B2 while Shipping imports B1, report `PROVIDER_INPUT_MISMATCH` with both identities. Evaluate the calls against B2 and report any incompatibilities. Do not allow a successful B1 assessment to stand in for B2 integration. Conversely, Shipping's B1 project assessment remains meaningful without pretending it certified B2.

Initially require exact selected export-digest alignment for family approval. A later compatibility policy may explicitly accept a different digest with a recorded comparison; signature addition/removal alone is not a complete behavioral compatibility checker.

Source conformance belongs to the owner root. The parent should collect each owner's code assessment, then map cross-root imports through an explicit source/package ownership index. Unsupported or unresolved cross-root imports must have a coverage result. Existing code analysis should not be presented as a complete inter-project import proof: the conformance rules deliberately skip chained implementations, while `buildCodeModel` receives paths interpreted relative to one root.

**Migration.** Keep the current fixes as compatibility protection. Add structured resolution and provenance first, then replace result-level fallback. Introduce explicit family/project modes before changing the meaning of existing `validate` invocations. Preserve the CLI distinction between errors, fatal warnings, and draft notices; [isCiDraftWaivable](../../../../../../src/commands/validate.ts#L43) shows why a severity-only ordering is insufficient.

**Proof.** Same canonical edge, call site, policy, evidence, and approval context gives the same finding and gate consequence from every entry point. Adding an unrelated unresolved edge cannot change another edge's verdict. Reusing one issue code for two targets cannot merge away either finding. Missing code-analysis coverage cannot become a successful family gate by omission.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

1. **The specific lenient-parent regression is fixed here.** [validation.ts](../../../../../../src/core/validation.ts#L66) now limits fallback replacement to resolution-failure codes, keeps stronger child findings, and combines severity overrides using the stricter effective severity. The three regression cases at the end of [resolve-through-parent.test.ts](../../../../../../tests/core/resolve-through-parent.test.ts#L469) pass. This does not make the parent run use every child's own policy, or make the fallback independent of unrelated findings.

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P4 | A child declares a missing nested mount. Unscoped parent validation reports `SUBPROJECT_NOT_FOUND`; parent validation scoped to the child drops that finding. | Some loader diagnostics still have local ids and disappear under a qualified scope. |
| P6 | Pin a published parent portal, then make it private without updating the pin. The child's pinned edge has no private-access finding. Add a separate component with an unresolved local dependency: the same pinned edge now receives `CROSS_SUBSYSTEM_PRIVATE_ACCESS`. | An unrelated resolution failure activates fallback and changes which evidence judges another edge. Pin precedence is conditional, not a coherent mode. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
