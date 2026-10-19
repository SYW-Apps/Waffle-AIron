_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth. Where the review's confinement text was exploit-level (probe P3's setup, one sentence naming a bypass class), a design-level summary stands in its place, marked in italics; the specifics were given to the maintainer directly._

## 09 — Hosted: a child as a project, a part, or both

**Diagnosis.** Current authorization targets the top project record, while execution can bind a child directory. [ProjectBinding](../../../../../../src/server/projects.ts#L247) carries a path and top-level id, plus an optional qualifier. Tools have to remember which interpretation applies. The [record-tool refusal set](../../../../../../src/server/request.ts#L203) is a useful guard but does not express every future operation's scope.

One remaining source-level concern deserves explicit attention: `validateSddTree` calls `findChainingParent` to discover a parent before `resolveThroughParent` checks `parentReach`. Thus the resolver's later refusal does not itself prove that no parent discovery reads occurred. The guarded [resolveChainingParent](../../../../../../src/core/specs.ts#L2934) wrapper checks reach first, but validation takes the lower-level path. This is a read-boundary observation, not a claim that I demonstrated a remote data-exfiltration exploit.

The P3 top-root/immediate-root mismatch is independently reproduced. *[Design level, see the provenance note: the check is lexical, and canonical filesystem reach is not established by it.]* The requested permission property needs canonical filesystem reach and access enforcement at the I/O boundary.

**Options.** Keep children permanently unregistered and add more qualified tool exceptions. Register a second unrestricted project over the same files, risking overlapping authority and history. Give each project root one canonical hosted identity and let authorized compositions reference it.

**Recommendation.** Adopt the third option. A hosted child can be opened and governed as its own project while remaining a member of a family. One canonical registration should own a given writable project root. Parent membership then references that registration, with an explicit composition access grant.

A binding should carry the target owner identity, allowed source roots, available imported contracts, requested composition context, and effective capabilities. Descriptors for MCP, REST, UI, background, and export operations should declare their read/write scope; registration should reject operations without a classification. Checks must apply to resolved targets, including nested members, before opening files or rebinding another root.

Preserve the authorized ability of a parent user to work across the family through explicit grants. Do not turn arbitrary dependency imports into permission to read or modify a provider. A child-scoped session can consume its authorized vendored contracts without reading private sibling or parent trees. An integration assessment outside its reach is unavailable or supplied as authorized evidence, never inferred by privileged filesystem discovery.

Audit both the initiating composition/session and the target owner project. Approval requests, history, git bindings, and the UI should use that same owner identity. The child UI can show the allowed membership context and navigate to its own L0, status, diagram, and approval page.

Organizational units remain administrative grouping. Membership is architecture/source composition. Hosted relations can represent contract-consumption connections. They should share identities and contract health, but a team hierarchy must not determine software containment or grant data access automatically.

**Migration.** Create canonical child records with explicitly preserved existing grants and persistence mappings. Retain `project::child` selectors as compatibility aliases. Reject overlapping writable registrations and surface any authority conflict before enabling the new record. Do not infer a grant from filesystem nesting.

**Proof.** Every operation is checked for both the owner target and required capability. A denied child context performs no ancestor discovery reads. Adding an unclassified tool fails registration. Parent-mediated and child-direct approved edits target the same files and audit the same owner. Nested traversal, absolute paths, symlinks, junctions, and missing paths have consistent outcomes at every root.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

5. **Confinement is narrower than the statement's blanket guarantee.** The loader checks a nested path against the *loading root*, while writer and hosted mount-binding paths check each owning root. The check is lexical, not a filesystem real-path check. See probe P3 and issue 09. Existing containment tests establish absolute-path and traversal cases, not universal confinement.

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P3 | *Filed at design level — see the provenance note.* Whether a nested mount is contained is decided against the **loading** root rather than the **owning** root, so one and the same declaration is accepted from one root and refused from another. The check is lexical. | Even mount membership and containment depend on the loading root. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).
