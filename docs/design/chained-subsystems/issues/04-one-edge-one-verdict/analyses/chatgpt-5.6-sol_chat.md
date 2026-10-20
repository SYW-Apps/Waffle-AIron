_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 04 — One edge, one verdict: composing judgements across roots

### Diagnosis

The current algorithm mixes three things:

```text
edge resolution
policy selection
availability of live ancestors
```

and then replaces findings from one validation with findings from another. Pins can alternatively suppress that fallback. This makes the checkout topology itself part of the validation input.

### Options

**A. Live tree always wins over pins.**

Detects recent provider changes immediately but makes a detached checkout mean something different from an attached checkout.

**B. Pins always define consumer validation; family validation separately checks live compatibility. Recommended.**

Strongest R1/R2/R7/R10 result.

**C. Never use pins; always fetch provider.**

Simple semantics, but no offline independent validation.

**D. Union live and pinned findings.**

Useful as diagnostics, but should not define CI semantics because ambient source availability still changes output.

### Recommendation

Shipping's validation graph is fixed by Shipping's lock:

```text
Shipping specs
Shipping config
Shipping code
Shipping deps.lock
```

Nothing else.

Platform family validation may additionally know:

```text
the Billing member's current surface
```

and add:

```text
WAI_COMPOSITION_INCOMPATIBLE
```

if current Billing cannot satisfy Shipping's locked requirement.

Critically:

```text
Shipping edge verdict:
PASS against required Billing contract X

Platform:
PASS against required Billing contract X
ERROR: composed Billing Y does not satisfy X
```

That is not two verdicts for one edge. It is one edge verdict plus a composition failure.

An explicit developer diagnostic may exist:

```console
wairon validate --against-workspace
```

but it must be clearly marked non-reproducible and must not silently replace ordinary CI behavior.

### Migration

Remove `resolvedThrough` as a semantic mechanism.

Old output may retain:

```yaml
resolvedThrough: ...
```

for compatibility/display during one migration cycle, but schema-v2 validation does not use it.

### Proof

Run Shipping in:

```text
standalone clone
nested under Platform
side-by-side workspace
hosted child scope
```

with identical Shipping files.

Shipping-owned findings must be identical.

Platform may add only findings whose scope is explicitly:

```yaml
scope: composition
owner: acme.platform
```
