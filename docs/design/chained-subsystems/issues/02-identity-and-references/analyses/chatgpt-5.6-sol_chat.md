_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 02 — Identity and references across roots

### Diagnosis

Identity is currently based on a traversal path through whichever tree loaded the object. Consequently `::`, `super::`, mount aliases, flat-child shortcuts and pin suffix matching all act as competing naming systems. The same textual reference can therefore acquire different meaning under a different loading root.

### Options

**A. Keep relative paths, but define them more rigorously.**

Could remove clamping and rewriting, but Shipping would still depend on Platform's name for Billing.

**B. Always spell canonical project IDs.**

```yaml
acme.billing::invoice_portal
```

Very predictable, but verbose and unpleasant under namespace changes.

**C. Local aliases resolving to canonical project IDs. Recommended.**

Like an import table.

**D. Give every spec an opaque UUID.**

Excellent rename stability but hostile to authored specs and probably unnecessary. Interface renames should generally remain meaningful contract changes.

### Recommendation

Shipping declares:

```yaml
dependencies:
  billing:
    project: acme.billing
```

and writes:

```yaml
dependsOn:
  - "@billing::invoice_portal"
```

Narrative:

```yaml
steps:
  - call: "@billing::invoice_portal.create_invoice"
```

Rules:

```text
foo
    same-project id

@billing::foo
    foo inside the project bound to local alias billing

::foo
super::foo
    deprecated; invalid in schema v2

suffix-only contract matching
    forbidden
```

Resolution is always exact:

```text
source project Shipping
  alias billing
    -> canonical project acme.billing
       local id invoice_portal
```

The parent stores the spec's lexical project while loading it. It does not reinterpret the string.

### Migration

Given:

```yaml
super::billing::invoice_portal
```

inside Shipping, migration discovers that Platform's alias `billing` resolves to `acme.billing`, adds:

```yaml
dependencies:
  billing:
    project: acme.billing
```

to Shipping and rewrites:

```yaml
@billing::invoice_portal
```

Only Shipping is changed.

If two pins currently match the same last segment, migration must stop with ambiguity rather than preserve first-match semantics.

### Proof

For every reference `r` in project `P`:

```text
resolve(P, r)
```

must be invariant under:

```text
loading root
parent alias
filesystem location
nesting depth
```

Additional tests:

```text
renaming Platform's billing member alias does not change a Shipping reference
two providers exporting `portal` never collide
there is no syntactically valid "too many parents" path
saving through Platform leaves Shipping source text byte-identical
```
