_Section copied verbatim from [`responses/chatgpt-6-astra_chat.md`](../../../responses/chatgpt-6-astra_chat.md), the generated file of the ChatGPT 6 Astra answer (answered `problem.md` r2 · no repository access). The chat text of the same answer, [`responses/chatgpt-6-astra_chat_response.md`](../../../responses/chatgpt-6-astra_chat_response.md), was compared with it sentence by sentence: the two are one answer in two renderings, the chat text a terser paraphrase, and the generated file the fuller of the two in every section — so it is the base here. Whatever the chat text alone says is quoted under "Chat-text form" at the end._

## 05 — Contracts across the boundary: pins and freshness

**Diagnosis.** Pins are simultaneously dependency declarations, caches, and approximate freshness indicators. Their family-wide hash describes the wrong change boundary.

**Options.**

- **Always refresh family surfaces:** catches some changes but violates reproducibility and risks R4 through automated updates.
- **Make pins detached-only caches:** preserves a live family gate, but fails R7 unless input selection becomes explicit.
- **Lock declared contract inputs; compare selected provider outputs separately:** satisfies R2, R7, R10, and R11.

**Recommendation.** Use one import mechanism for relatives, unrelated projects, and hosted publications:

```yaml
# Shipping: .wai/inputs.lock.yaml
imports:
  billing:
    project: syw.billing
    contracts:
      invoice_portal:
        digest: sha256:C1
        artifact: surfaces/billing-invoice-C1.yaml
```

The artifact records publisher identity and provenance, exported component identity and stereotype, method signatures, reachable contract types, and publication/access metadata. Its digest covers those semantics, excluding unrelated specs and the consumer's own imports. It is an immutable expected input, not evidence of current deployment availability.

Initially lock complete named interfaces and their type closure. Compatibility compares the promised interface with the selected provider's interface: additions may be compatible; removed methods, narrowed access, or incompatible signatures fail. Unsupported compatibility cases are reported as unknown, not presumed safe.

| Observation | Gate behavior |
|---|---|
| A newer contract exists | Informational; do not mutate the lock. |
| Selected provider still satisfies the pinned contract | Integration passes even when digests differ. |
| Selected provider breaks the contract or removes the export | Integration fails. |
| Required artifact/provider evidence is missing or corrupt | Incomplete/error; CI fails. |
| Import is unused | Informational; explicit pruning command. |

Replace `surface pin`'s family enumeration with explicit `deps add`, `deps update`, and `deps check --context F`. Fetching or importing writes only the requesting project's inputs. Platform's own public contracts replace the special “family surface”; descendants need explicit imports just like any other provider.

**Migration.** Convert pins only when their provider/export provenance is unambiguous. Rebuild or reacquire insufficient artifacts. Retire the whole-family freshness hash. Existing valid snapshots can remain pinned without contacting the original parent.

**Proof.** An unrelated Payments edit changes neither Shipping's contract digest nor its project result. A renamed Billing method fails the selected composition from both scopes. Duplicate export names never select the wrong provider. Validation never rewrites pins.

**Chat-text form.** Nothing beyond wording.
