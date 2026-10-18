_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 08 — Repository layouts and version control

**Diagnosis.** Filesystem nesting is doing dependency resolution, while backup operates over only one of the project's storage locations.

**Options.**

- **Require nested checkouts/submodules:** operationally simple, but drops part of R8.
- **Allow arbitrary paths directly from project YAML:** supports layouts but turns a manifest into ambient filesystem access, conflicting with R6.
- **Explicit source bindings within an authorized workspace:** preserves R6, R8, and R11.

**Recommendation.** Support nested paths, registered workspace projects, and immutable fetched sources:

```yaml
members:
  billing:
    project: syw.billing
    source: {workspace: billing}

---
# Separate, explicitly selected workspace descriptor
projects:
  billing:
    project: syw.billing
    path: ../billing
```

Resolve paths against the declared descriptor, verify project identity and content, and enforce authorized real paths. Hosted source bindings resolve through registered project records rather than user-supplied paths. Keep the existing nested-path escape restriction for that source form; side-by-side support should not silently relax it.

A missing required member makes a working-family assessment incomplete. An immutable context may use exact cached snapshots and trusted matching analysis evidence. A contract-only dependency needs its contract, not the provider's whole checkout.

Git revision and approval subject remain separate, linked evidence: a commit locates bytes; approval records a human decision about specific semantics. A source-only commit can preserve architectural approval while invalidating code-analysis evidence.

Hosted backup enumerates all authorized member roots. Commit all relevant `.wai` paths once per Git repository; handle submodule repositories separately. Record a composition manifest connecting their revisions and approval subjects. Retain the underlying objects/artifacts, not just commit strings. State separately whether a backup includes source code or only architecture data.

**Migration.** Existing nested paths remain valid bindings. Add workspace bindings for separate repositories and expand hosted backup coverage. No content migration is needed merely to choose another transport; version the expanded backup format and retain support for older restores.

**Proof.** Equivalent monorepo, submodule, and side-by-side snapshots yield equal semantic results from both scopes. A restored family reproduces approvals and inputs at every depth. Symlinks cannot change ownership or escape authorized roots.

**Chat-text form.** Nothing beyond wording.
