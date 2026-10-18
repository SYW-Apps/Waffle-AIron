_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 03 — Governance: whose rules judge a child's specs

**Diagnosis.** Configuration selection is a loader side effect. A rule's authority and applicability are absent from the finding.

**Options.**

- **Top-root override:** prioritizes R3 but violates R2 and R7.
- **Child-only governance:** preserves R2 and R7 but provides no system admission criteria, limiting R3 too far.
- **Owner policy plus explicit composition requirements:** preserves independent judgement while allowing the parent to reject an unsuitable composition; satisfies the revised R3.

**Recommendation.** The owner evaluates every owned spec under its own configuration and pinned policy imports. Parent requirements are additional predicates, never replacements:

```yaml
# Each participating service, including Payments
policy:
  profiles: ["syw.service@sha256:P1"]

# Platform
composition:
  requirePolicies:
    - {profile: "syw.service@sha256:P1", scope: descendants}
```

`P1` is a symbolic digest here. A required profile defines a floor its adopters cannot disable. Local rules may add constraints. Suppressions name their issuing policy; a parent suppression cannot waive a child's finding. For the same rule semantics, severities combine by the stricter floor. Distinct pack predicates remain separate obligations; incompatible predicates produce a policy conflict, not a guessed merge.

Each composition node's requirements apply over its declared scope. Thus Billing's Payments requirements and Platform's descendant requirements both apply. No special top-root authority skips Billing. Project type and target language are explicit owner values; scaffolding may copy defaults once. General automatic inheritance would make detached interpretation depend on missing files.

**Migration.** Keep child configurations intact; translate existing parent-wide doctrine into explicit composition checks. Report changed outcomes. Adoption of a shared profile and any policy conflict resolution require ordinary project changes and approval, not silent config rewriting. Where the two scopes previously disagreed, no migration can preserve both verdicts while making them consistent.

**Proof.** The statement's invalid child-internal Orchestrator edge remains an error with a parent configured to error, warn, or off. Payments sees the same adopted profile locally and through Platform. Updating Platform's required profile fails admission until adoption; it does not rewrite Payments' current policy.

**Chat-text form.** One sharper phrasing: "Nothing skips intermediate parents." (the generated file: "No special top-root authority skips Billing."). Otherwise a paraphrase.
