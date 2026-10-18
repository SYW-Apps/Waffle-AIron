_Section copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth._

## 01 — Mount and realization: two specs for one subsystem

**Diagnosis.** The current merge is semantically lossy, even after fixing its depth behavior. [mergeMountRealizations](../../../../../../src/core/specs.ts#L401) retains the child object's fields and only the mount's `projectPath`. The path map also selects the child's file. Thus the apparent single object combines data and write ownership from different authored records. Multi-subsystem children expose the contradiction because there is no single L1 realization to merge.

**Options.** Retaining explicit mount-over-child precedence would make the loss visible but preserve two authorities for one interface. Requiring every child to be flat would simplify merging but restrict R2 and R9. Removing the mount from the L1 collection removes the false equivalence while supporting both child shapes.

**Recommendation.** Introduce a membership record separate from `SubsystemSpec`. Preserve both parent-authored membership metadata and the child's own L0/L1 records. The parent may give the member a display label, required policy, or selected export set; it may not manufacture exports the child has not published.

Billing's L0 can publish a stable export using the existing shape:

```yaml
# Billing/.wai/specs/.index.yaml — publication fragment
publicInterfaces:
  - id: invoices
    name: Invoices
    subsystem: billing
    component: invoice_portal
    type: Custom
    details: Invoice operations offered to the family
    audience: project
```

The new composition model must define how the current `project` audience maps to explicit family access. Reusing the spelling alone is not an access-control design. Existing L1 `publicInterfaces` remains the subsystem's boundary inside its owner project.

Creating a project member must produce a valid standalone project structure. If the command promises to create a subsystem, it must also create that real L1 inside the child. Attaching an existing project must preserve its L0 and actual subsystem set. Creation and attachment should be distinct operations.

**Migration.** Report all mount/child publication and trust disagreements before conversion. Preserve discarded mount metadata in the migration report, and require a deliberate choice where it changes access. Existing flat children can produce proposed L0 exports from their L1 publication; do not automatically publish every subsystem in a multi-subsystem child.

**Proof.** Renaming a membership alias does not change child L1 identity or export contents. Flat, differently named, and multi-subsystem children have the same loading rules. A parent and child record with conflicting text remain distinguishable and writable through their respective owners.

## Filed here from the review's corrections and probes

_The items below are the review's statement corrections and characterization probes that concern this issue, quoted from its "Scope and evidence" section (the full section is under issue 00)._

2. **Flat grandchildren and declaration shadowing have fixes here.** [qualifyDeclaredId and qualifySubsystemRef](../../../../../../src/core/specs.ts#L129) distinguish declarations from references and handle a same-id realization at arbitrary mount depth. The Payments duplication described in issue 01 is therefore not an outstanding example on this commit. The root-subsystem shortcut for *references*, and the implicit mount/realization merge, remain.
