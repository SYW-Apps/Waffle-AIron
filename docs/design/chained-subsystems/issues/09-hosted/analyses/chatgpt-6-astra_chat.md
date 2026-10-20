_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 09 — Hosted: a child as a project, a part, or both

**Diagnosis.** Hosted identity is tied to top-level storage, and confinement is an accumulating tool exception list.

**Options.**

- **Top-level records with more child forwarding:** cheap initially, but repeats the R2/R6 mismatch for each new tool.
- **Independent records with automatic ancestor privileges:** improves R2 but makes project reuse dangerous under R6.
- **Independent records with explicit membership grants and typed capabilities:** preserves R2, revised R3, and R6.

**Recommendation.** Register every project once, with its own policy, approval page, history view, and permissions. Several composition records may point to it. Monorepo projects share a repository service without sharing project authorization.

Bind every operation to a resource and capability: `(principal, projectId, action, permitted artifacts)`. Implement this in the common project service and filesystem gateway. A new tool cannot bypass it by forgetting a child-specific branch. A project id read from YAML is not sufficient to acquire access to a hosted record.

Family access requires explicit member grants. Child-scoped access excludes other project roots, including nested ones, except for deliberately shared contract/context artifacts. Sessions identify their bound project, allowed operations, and any disclosed membership context.

The UI can open Shipping directly or through Platform and invoke the same approval workflow. Audit records the actor, target project, operation, and initiating composition, without routing ownership to Platform. Organizational units group people and policy; architectural `member`/`consumes` relations use the same graph in hosted relation-health views.

A child can revoke its own delegation grant or retire its availability. Removing a membership declaration owned by Platform still requires a Platform change. “Detach” is not permission to edit another project.

**Migration.** Create records for existing children and map existing narrowed tokens to explicit capabilities. Preserve their current restrictions unless deliberately expanded. Migrate audit provenance and source bindings; existing parent access becomes recorded grants, not inferred permanent power.

**Proof.** Run every tool, including archive, generation, backup, and future-tool defaults, with child-scoped credentials. Unauthorized reads/writes and path escapes fail centrally. The same authorized Shipping edit through its page or Platform targets the same record and produces the same content.

**Chat-text form.** Nothing beyond wording.
