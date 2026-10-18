_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 04 — One edge, one verdict: composing judgements across roots

**Diagnosis.** Resolution, evidence selection, authority, and diagnostic aggregation are intertwined. Replacing selected diagnostic codes cannot establish semantic consistency.

**Options.**

- **Live tree wins when present:** catches integration drift but makes checkout contents select the question; violates R7 and R11.
- **Pins always win:** makes the child reproducible but cannot establish that the selected family provides its dependencies; weakens R3.
- **Explicit project and composition assessments:** preserves R1's qualified equality, R2, R3, and R7. Recommended.

**Recommendation.** Define the project evaluator `V(P)` over P's selected owned specs and code, owner approval, owner configuration, pinned contracts, and validator/pack versions. A family context F selects project snapshots and actual provider bindings:

```text
Family(F) = all V(P) for selected members and the root
            AND all import-to-provider compatibility checks in F
            AND all applicable composition policy checks
```

Here AND means all required assessments must pass. Findings are retained with their issuer and basis; they are not replaced or collapsed by diagnostic code. Owner findings are identical whether requested directly or collected by a family run.

```bash
wairon validate --ci
wairon validate --family --inputs working --ci
wairon validate --context .wai/contexts/platform-F1.yaml --ci
```

The first checks the owner's current snapshot against locked inputs. The second explicitly snapshots the declared working family and checks every imported contract against its selected provider, even if an owner pin already passed. The third evaluates the explicitly supplied immutable context. Materialized bytes must match its selected digests; a different checkout is not a substitute. An old context can pass only as an assessment of those old snapshots; its output must identify them.

There is no ancestor fallback. Missing inputs produce `incomplete`, which fails CI. Unsupported required code analysis also produces incomplete coverage. Unwaived warnings continue to fail CI.

Code conformance belongs to the source file's owner. Each analyzer checks its outgoing imports/calls, including imports across project boundaries, against canonical dependency and exported-symbol mappings. Family validation runs or reuses those owner checks and verifies provider bindings. Ownership indexes exclude nested child roots from parent code scanning; every file has exactly one owner. A cross-project import unsupported by the language adapter is not silently ignored.

Settledness comes from the spec owner's approval. Cache keys include all semantic inputs, source digests, approval state, and analyzer versions.

**Migration.** Replace fallback merging with a shared evaluator and an explicit assessment context. Run old and new evaluators side by side during adoption to expose verdict changes. Correct cases remain compatible; projects relying on missed or softened findings will deliberately start failing.

**Proof.** For identical inputs, a family report's owner findings equal a direct owner run. Deleting a selected provider method or export fails integration from Platform and from Shipping supplied with the same context. Parent-code-to-child and child-code-to-parent import fixtures both fail when undeclared. Changing the working directory or adding an unused checkout changes nothing.

**Chat-text form.** One sharper phrasing: "Undeclared imports fail in both directions across a project boundary." (the generated file: "Parent-code-to-child and child-code-to-parent import fixtures both fail when undeclared."). The generated file alone adds "Owner findings are identical whether requested directly or collected by a family run."
