_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 10 — Migrations: create, externalize, internalize, move, rename

**Diagnosis.** Ownership-changing operations are implemented as file moves plus partial string rewrites. They need graph transformations with an explicit affected-owner set.

**Options.**

- **Best-effort rewrite of checked-out files:** convenient, but violates R5 and R11 when absent consumers break.
- **Always require the entire family online and writable:** safer, but unnecessarily limits R2, R8, and R10 for alias/path-only changes.
- **Classify transformations by semantic effect; plan all affected writes:** preserves the commitments with honest limits on cross-repository atomicity.

**Recommendation.**

| Operation | Required change |
|---|---|
| Create | Explicitly create the child L0/L1/config and parent membership; never defer scaffolding to lock. |
| Rename membership alias | Parent metadata only; consumer aliases and canonical ids remain unchanged. |
| Move checkout | Source binding and any necessary VCS metadata; verify source resolution remains equivalent. |
| Reparent/add membership | Composition declarations, grants, and applicable requirements; no consumer reference rewrite. |
| Externalize a subsystem | New owning project, reference/import rewrites in all affected owners, publication and boundary checks, path rebasing, approval drift. |
| Internalize a project | Move all selected local subsystems with an explicit collision map; preserve nested project memberships. No flat-child restriction. |
| Rename stable project/spec id | Breaking identity migration; update known consumers or maintain a real compatibility publication under the old identity. |

Changing membership into mere consumption is a relation edit, not a project kind migration. Adding membership likewise does not grant private dependency access.

Plans contain expected input digests, owner-by-owner patches, identity mappings, boundary changes, approval impact, and unavailable owners. A stale precondition stops application. Extraction can create new architectural boundaries; a transformation must report newly required Adapters/contracts rather than assume moving files preserves validity.

Within one repository, publish the complete change in one commit. Across repositories, prepare compatible releases or patches and publish the new immutable composition manifest last. This is an atomic selection of versions, not a globally atomic edit of independent Git repositories. If required owners are unavailable, leave the migration explicitly pending. Unknown detached consumers require compatibility/versioning, not a claim of exhaustive rewriting.

**Migration.** Add a plan/apply layer around existing operations, using canonical graph resolution. Accept nested selections and multi-subsystem internalization. Keep old identities available during staged public migrations where needed.

**Proof.** Path and alias changes preserve every canonical edge from all scopes. Ownership-changing transformations preserve intended targets under their explicit mapping and revalidate new boundaries. Missing owners or concurrent edits cannot produce a successful “complete” result. Failure leaves the previous committed composition usable.

**Chat-text form.** Nothing beyond wording.
