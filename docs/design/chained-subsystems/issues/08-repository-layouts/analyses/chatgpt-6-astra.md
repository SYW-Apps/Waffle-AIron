_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth. Where the review's confinement text was exploit-level (probe P3's setup, one sentence naming a bypass class), a design-level summary stands in its place, marked in italics; the specifics were given to the maintainer directly._

## 08 — Repository layouts and version control

**Diagnosis.** Filesystem containment currently doubles as membership discovery and source acquisition. Git backing follows hosted root records, while spec loading follows recursive mounts. Those traversals cover different sets of data.

There is also a concrete approval-persistence mismatch beyond child backup: [excludeLocalFiles](../../../../../../src/git/adapter.ts#L96) still adds `.wai/lock.json` to `.git/info/exclude`, and [the git enable workflow](../../../../../../src/git/orchestrator.ts#L28) calls it. An already tracked lock is not untracked by an ignore rule, but a newly generated lock can remain untracked. This conflicts with the premise that approval records are committed and portable.

**Options.** Nested paths only keep today's layout restriction. Accepting arbitrary mount paths weakens hosted confinement. An explicit source/workspace resolver supports multiple layouts while keeping authorized filesystem reach separate from membership semantics.

**Recommendation.** Make these first-class layouts:

| Layout | Source and persistence behavior |
|---|---|
| Monorepo | Resolve member roots explicitly; a reviewable commit may include their `.wai` paths in the same repository. |
| Git submodules | Record and verify each child checkout/revision; child commits and superproject gitlinks are separate operations. |
| Separate repositories | Bind declared project identities to authorized local checkouts or immutable artifacts; do not discover them by walking `..`. |

For local sibling repositories, an explicit workspace mapping can authorize the known roots. Hosted resolution should use registered project/source handles, not permit tenant-authored arbitrary filesystem paths. Paths provide location; content/revision identities establish which state was selected.

Keep Git commit ids, contract digests, and approval digests separate. A Git commit includes more than a contract; the same contract can exist at many commits; an approval says which scope and policy a human accepted. A binding can record all three and check their consistency.

Backups should enumerate the declared family through the same membership resolver as validation, capture each owned `.wai` tree and its project identity, and record expected versus captured members. Fail a claimed full backup on unavailable members. Restore must reconstruct bindings and approvals, not merely extract reachable directories. A spec archive is not a backup of source code or independent repository history.

**Migration.** Keep contained path sources working. Add explicit repository/workspace bindings before allowing side-by-side layouts. Repair lock-file exclusion and make backup coverage visible before broadening claims about hosted recovery. Avoid silently committing child repositories or rewriting `.gitmodules` during a structural spec migration.

**Proof.** The same selected project states yield the same assessments under all three layouts. A restore preserves every declared project's specs, imports, and approval metadata. Missing submodules and partial checkouts produce explicit unavailable-member results. Fresh hosted approval records actually enter the intended persistence path.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

5. **Confinement is narrower than the statement's blanket guarantee.** The loader checks a nested path against the *loading root*, while writer and hosted mount-binding paths check each owning root. The check is lexical, not a filesystem real-path check. See probe P3 and issue 09. Existing containment tests establish absolute-path and traversal cases, not universal confinement.
6. **A complete tree archive is conditional.** [listChainedRoots](../../../../../../src/core/specs.ts#L352) skips missing, escaping, and cyclic mounts, and stops deeper traversal after its depth limit. [exportSpecTree](../../../../../../src/core/treetransfer.ts#L220) also filters out roots without `.wai`. The archive mechanism supports families; its success alone does not prove that every declared member was captured.

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P3 | *Filed at design level — see the provenance note.* Whether a nested mount is contained is decided against the **loading** root rather than the **owning** root, so one and the same declaration is accepted from one root and refused from another. The check is lexical. | Even mount membership and containment depend on the loading root. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
