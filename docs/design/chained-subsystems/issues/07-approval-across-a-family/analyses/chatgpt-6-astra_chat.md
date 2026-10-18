_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 07 — Approval across a family

**Diagnosis.** A local approval and a composition approval are different promises. A direct-child lock pointer cannot prove that an arbitrarily deep current tree still matches approved content.

**Options.**

- **Parent approves every loaded spec:** simplifies a global badge, but defeats independent R2 governance and may violate R4.
- **Only local approvals:** preserves R2 and R4, but cannot fulfill composition approval under R3.
- **Local approvals plus explicit recursive composition approval:** preserves all three with two clearly labelled scopes.

**Recommendation.** Keep per-spec owner approvals. Bind their validity to the approved semantic configuration and input locks as well as spec digests. Add an optional composition section to the same project approval record:

```text
ownSubject(P) = H(project identity, owned specs, semantic config, input locks)

compositionSubject(P) = H(ownSubject(P), membership and selected bindings,
                          child composition subjects, integration policy/context)
```

For leaves, the composition contribution is derived from their approved own subject. Hash subjects, not approval timestamps, signatures, or the approval file itself. Transport aliases/paths do not change semantic identity; selected content does.

`lock` approves only the selected project's own subject. `lock --family --context F` approves its composition and requires recursively approved, matching selected members and successful integration. An intermediate project with children needs matching composition approval for its selected child arrangement. Both commands write only their target project's record. A parent can approve its own architecture before children are ready; status must say “own specs approved; composition incomplete.”

Approval preflight judges the candidate specs at settled strictness, so locking cannot turn today's accepted completeness warnings into tomorrow's newly settled errors. Code conformance evidence is separate, bound to the checked source/spec/tool digests; architecture approval is not a promise about arbitrary future code.

Verify actual selected content recursively. An unchanged Billing lock does not prove unchanged Payments. Historical approval remains valid for its historical snapshot; drift blocks claiming it covers the new composition.

**Migration.** Preserve old records as historical local approvals, with their original basis. Do not invent approvals for unapproved children or silently certify them under new policies. New composition approval requires the newly specified checks.

**Proof.** Editing Payments while leaving both ancestor lock files untouched makes current-family approval fail from Payments, Billing, and Platform. Reapproval propagates changed subjects upward. Parent locking modifies no child. Missing child approval cannot become a fully approved badge.

**Chat-text form.** Nothing beyond wording.
