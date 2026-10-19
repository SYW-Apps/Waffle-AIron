_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 07 — Approval across a family

**Diagnosis.** Today's lock combines a recursive gate hash, local file-review digests, and direct-child approval pins. These represent different promises. The hash misses imported surfaces and child governance, and `currentChildPins` copies a child's recorded StateId without establishing that the child's current contents still match its approval. Descendant content sensitivity is not a proof of descendant approval.

**Options.** One family approval would simplify authority but weaken independent project approval. Local approvals alone preserve autonomy but cannot justify “this composition is approved.” Local approvals plus a composition approval cover both promises without approving another team's changes implicitly.

**Recommendation.** Preserve per-file owner approvals and add a versioned composition record. Conceptually:

```text
project assessment inputs =
  own L0–L5 content + resolved policy + imported contract digests
  + analyzer identity and source evidence when code conformance is claimed

composition approval =
  own reviewed state + selected member approval digests
  + exact member state/bindings + composition-policy inputs
  + complete successful integration assessment
```

Record the complete approval identity of each direct member, including that member's own selected children. This permits transitive verification without flattening every descendant approval into Platform's file map. An approval identity must cover member/binding metadata and policy inputs, rather than merely copy the current `stateId` field.

Verify that a member's current selected state matches its approval; a stale approval file does not suffice. Missing or unapproved members can remain visible during design, but cannot support a claim that the full family is approved. A scoped approval must record its scope and coverage explicitly.

Keep “this spec's text was reviewed” separate from “the project still passes its declared gate.” An unchanged spec may retain review provenance after an import or policy change, but that change invalidates the previous gate assessment. The parent should derive child settledness from the child's actual record, not from the parent's local file map.

Human approval and source-code conformance also need distinct language. If the lock certifies only the architectural design, say so and track code-check results separately. If it certifies code conformance, source revisions/digests and analyzer context must be part of the evidence. Current source checks alone do not make a specs-only hash a durable code certificate.

Capture a stable input set before validation and compare it before committing the approval. A hosted approval request must remain tied to exactly that set while a human reviews it. No family transaction may fabricate missing child approvals.

Do not make imported contracts hash the provider's whole approval recursively. Dependency cycles would then create circular hash definitions. Immutable contract digests are leaf inputs; transitive approval follows the acyclic membership relation.

**Migration.** Version the lock format and report older records as legacy approval evidence requiring revalidation for stronger claims. Preserve their human/file provenance. Do not synthesize new family approvals from old direct-child pins.

**Proof.** Payments drift invalidates full-family readiness through Billing. An unchanged old Billing lock cannot conceal current Billing edits. Altering an imported contract, member policy, or composition binding invalidates the relevant assessment. Approving Platform writes only Platform's approval record.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

4. **Approval has both local and recursive aspects already.** [currentSpecDigests](../../../../../../src/core/approval.ts#L88) excludes child specs from the per-file approval map, and `children` records only direct children's approved StateIds. However, [hashGateState](../../../../../../src/core/statehash.ts#L162) hashes the recursively loaded spec tree as well as the bound root's doctrine. Payments' loaded L1–L4 content can affect Platform's gate hash. The accurate gap is missing *transitive approval provenance and owner context*, not complete absence of descendant content from Platform's approval identity.

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P2 | A child calls `old()` through an imported surface. Replace only that surface with one exposing `new()`. `SURFACE_REF_NOT_EXPOSED` appears, but `computeGateStateId()` remains identical. | An input capable of changing the gate verdict is absent from the gate identity. This directly matters to approval validity. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
