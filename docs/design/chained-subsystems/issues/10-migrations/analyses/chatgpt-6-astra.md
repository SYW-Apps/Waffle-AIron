_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 10 — Migrations

**Diagnosis.** Structural operations manipulate directories and selected strings without an explicit before/after ownership graph. They therefore cannot reliably preserve reference targets, imports, policy, approval, and code ownership. P7 shows that even a moved subsystem's outgoing edge can be lost. Current [rewriteRefsInDir](../../../../../../src/core/provision.ts#L508) handles selected fields and exact strings, not the complete reference language.

There are additional lifecycle costs: externalization provisions a target project before the move, and internalization [removes the child's entire `.wai`](../../../../../../src/core/provision.ts#L464). Imported surfaces, project settings, root-level types, approval metadata, and nested membership need explicit preservation or rejection rules. A flat L1 count alone is not enough evidence that deleting that project metadata is harmless.

**Options.** Best-effort in-place rewriting is convenient but cannot promise R5 or R11. A transaction over one repository can atomically publish a complete structural edit. A staged migration protocol can support several repositories, but cannot honestly promise one atomic Git commit across them.

**Recommendation.** Every migration should produce a concrete plan before applying it:

```text
before: project identities, selected states, resolved reference targets
changes: files/owners, member bindings, imports, exports, code paths
after: expected targets, policy inputs, approval invalidations
coverage: absent consumers, unavailable roots, unresolved ambiguities
```

Creation initializes the promised local structure. Attachment does not overwrite an existing project. Externalization establishes a new owner and rewrites both inbound and outbound references. Internalization requires an explicit destination for all child-owned metadata and resources, with a compatibility plan for published identities. A path move changes location. A membership alias rename changes presentation and compatibility addresses. A project-id change is a breaking identity migration and must be treated separately.

Use parsed reference positions and a canonical target map, including signatures and nested generic/union types. Determine source ownership before rebasing paths; turning a formerly valid source file into `../../src/file.ts` outside the new owner root is a reported migration consequence, not a successful standalone conversion.

For multiple repositories, publish compatible exports/aliases first, update consumers through reviewed changes, then remove old bindings only when supported consumers have moved. Without all consumers checked out, report incomplete coverage and preserve a compatibility surface where possible. Refuse a claimed complete breaking rewrite when it cannot be proven.

Within one controlled workspace, stage edits, recheck input digests, and apply with rollback/recovery support. For separate Git repositories, record progress and commit identities; a partial failure must be recoverable and visible. Neither process should grant fresh approvals automatically.

**Migration.** Initially add planning and refusal checks around existing operations. Converting legacy mount/reference semantics is itself one of these migrations, with before/after assessments available for review. Preserve legacy files and approvals as evidence rather than treating them as disposable scaffolding.

**Proof.** Before/after canonical reference targets match for every promised unchanged relationship. Cross-root source references remain valid or explicitly block the plan. Failure halfway through produces a known recoverable state. Unavailable consumers and metadata that cannot be preserved prevent an operation from claiming complete success.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P7 | An internal subsystem has an outgoing Adapter dependency on a published portal in another parent subsystem. Externalize it. The moved dependency stays bare and becomes `moving::portal`, which does not exist. | Migration misses outgoing references inside the moved subtree, in addition to references held by other children. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
