_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 02 — Identity and references across roots

**Diagnosis.** A loader's route to a project has become the project's identity. Tail matching and implicit absolute-name detection then compensate for ambiguous addressing.

**Options.**

- **Strict `super::` paths:** removes some ambiguity but keeps references coupled to parent topology; weakens R8 and R11.
- **Globally qualified references everywhere:** stable and simple, but verbose; preserves R5 and R11.
- **Stable identity with owner-local aliases:** the same semantics with readable authoring; preserves R5, R8, and R11.

**Recommendation.** Use immutable, namespace-qualified project ids such as `syw.billing`; display names remain mutable. Local spec ids are unique within their owning project. Treat an intentional identifier change as a migration.

```yaml
# Shipping's project.yaml
imports:
  billing:
    project: syw.billing
    contracts: [invoice_portal]

# Shipping's component / narrative references
dependsOn: ["dep:billing/invoice_portal"]
target: "dep:billing/invoice_portal#create_invoice"
```

The authoring project is always Shipping, even when the MCP session opens at Platform. Resolve to `(syw.billing, invoice_portal, create_invoice)` together with the explicitly selected contract or provider-snapshot digest. Revisions select an incarnation of an identity; they are not mount prefixes.

Reject undeclared imports, ambiguous provider identities, out-of-bounds `super::`, and legacy root-sensitive `::` in the new schema. Deduplicate graph edges after canonical resolution. Preserve authored spelling on ordinary saves; canonicalization is an explicit formatter operation. Platform may still display `billing::invoice_portal` as a breadcrumb, never as stored identity.

**Migration.** Resolve old references using a declared legacy family context, then write owner-local imports and references. Compare live and pinned candidates; do not turn the old first-tail-match winner into an unquestioned identity. Unambiguous references migrate mechanically; ambiguous collisions and clamped references require repair. Rewrite every affected owning project, not just the parent.

**Proof.** Renaming a membership alias, relocating a checkout, and changing nesting preserve canonical targets. Two providers publishing `portal` remain distinct. Pin order has no effect. Identical owner-scoped MCP edits through child and parent produce identical files.

**Chat-text form.** One sharper phrasing: "Pin order cannot affect resolution." (the generated file: "Pin order has no effect."). The generated file alone adds "Revisions select an incarnation of an identity; they are not mount prefixes."
