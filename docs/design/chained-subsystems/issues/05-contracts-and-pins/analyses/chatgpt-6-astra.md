_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 05 — Contracts and pins

**Diagnosis.** A snapshot currently serves as a dependency declaration, contract cache, name-resolution fallback, and freshness signal. Its content may omit information the live rules need. Its provenance hashes too much, while the approval hash includes too little. P1, P2, P5, and P8 are different consequences of those distinctions being absent.

**Options.** Treat pins as offline caches and prefer live state; this gives convenient local updates but weakens reproducibility. Treat pins as immutable dependency inputs and add explicit integration/update checks; this satisfies R2 and R7. Require a full package registry and semantic-version solver; useful eventually, but unnecessary to solve the present issue.

**Recommendation.** Start with immutable contract inputs in the existing surface store, addressed by declared provider/export identity and a contract digest. Separate:

| Question | Evidence |
|---|---|
| Is the selected input intact? | Stored content matches the committed digest. |
| Does this consumer satisfy that input? | Project assessment against that exact contract. |
| Has the provider published a different contract? | Explicit comparison with an available selected provider state. |
| Does this family work together? | Composition assessment against its selected provider state. |

Hash contract-relevant facts, including the exported interface, reachable type definitions, guarantees, transport/call kind, and boundary eligibility. Decide explicitly whether documentation changes are contract changes; avoid adding every unrelated implementation or timestamp to this digest. Provider identity is part of the binding and verified with the snapshot.

A surface must preserve enough facts to run the supported boundary rules, or report the omitted check as unavailable. P8 specifically requires distinguishing an event subscription/export from a synchronous callable portal. Trusted-link treatment also differs between today's live and surface paths; it needs an explicit contract/boundary rule, not an accidental exception on one path.

Reconcile pins by declared imports. Detect unused imports, missing exports, removed providers, and ambiguous legacy providers separately. `surface pin` should not silently choose replacement providers or collect every sibling forever. Pin refresh is an explicit child edit, followed by normal validation and approval.

Staleness alone should not fail a reproducible historical project assessment. It should fail a family requirement when the pinned contract does not match the selected member state, or an explicitly configured update/revocation policy. An offline pin cannot reveal an online revocation made after publication; promising that would contradict detached operation. A release requiring current revocation checks must declare that additional input and fail if it cannot obtain it.

The family surface remains useful as a scoped publication artifact for detached children. It should represent explicitly exported contracts, with their own digests, rather than automatically becoming the identity of all specs in the family. Hosted and imported foreign surfaces should use the same contract schema and binding semantics.

**Migration.** Preserve old snapshot files as provenance. Derive exact contract digests only after resolving provider ambiguity. Fix the freshness/write-suppression mismatch independently. Invalidate old approvals for the new input-hash scheme; never claim they approved imports their digest did not cover.

**Proof.** Private provider edits leave contract freshness unchanged. A breaking contract change moves the contract digest. Re-pinning unchanged contracts is a true no-op without contradictory freshness. Two providers with the same export name remain distinct. Live and snapshot assessments agree for all facts the snapshot claims to represent.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P1 | Pin a child's family surfaces; add a private component in the parent; pin again. The second pin changes zero files, while every existing pin still reports `stale`. | Re-pinning does not necessarily repair the advertised freshness state. Content-based write suppression preserves the old whole-tree provenance hash. |
| P2 | A child calls `old()` through an imported surface. Replace only that surface with one exposing `new()`. `SURFACE_REF_NOT_EXPOSED` appears, but `computeGateStateId()` remains identical. | An input capable of changing the gate verdict is absent from the gate identity. This directly matters to approval validity. |
| P5 | Store two snapshots publishing `portal`, with the wrong provider first. Resolve `super::wanted-provider::portal`. The wrong provider wins. | Matching still discards provider identity, even when the reference spells it explicitly. |
| P8 | Publish an Observer through a MessageBus interface and pin it. An Adapter's `dependsOn` that Observer is accepted against the snapshot, but the parent's live check reports `CROSS_SUBSYSTEM_TARGET_NON_PORTAL`. | Surfaces omit facts needed to reproduce live boundary judgments; matching the right provider alone will not restore parity. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
