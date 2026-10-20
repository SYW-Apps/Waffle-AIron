_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 10 — Migrations: create, externalize, internalize, move, rename

### Diagnosis

Most current migration complexity is caused by references encoding physical composition paths.

If `super::billing` literally means “walk to my parent and find its mount called billing,” changing the family topology necessarily becomes a graph-wide source rewrite.

### Options

**A. Make every topology operation an atomic whole-family rewrite.**

Works in a monorepo but contradicts separate repositories and unavailable children.

**B. Stable project identities plus project-local aliases. Recommended.**

Most topology changes stop affecting references.

**C. Opaque immutable IDs for every entity.**

Would make even entity renames transparent, but I would not hide contract renames in this way.

**D. Permanent legacy aliases.**

Easy compatibility, accumulating long-term ambiguity.

### Recommendation

Under the proposed model:

### Move Billing's checkout

From:

```yaml
source:
  path: services/billing
```

to:

```yaml
source:
  path: ../billing
```

No architecture reference changes.

### Rename Platform's member alias

From:

```yaml
members:
  billing:
```

to:

```yaml
members:
  finance:
```

Only Platform-local references using `@billing` require updates.

Shipping continues to contain:

```yaml
dependencies:
  billing:
    project: acme.billing
```

so nothing changes there.

### Externalize an internal subsystem

This really does cross an authority boundary.

The migration should produce a plan:

```console
wairon externalize billing \
  --new-project acme.billing \
  --source ../billing \
  --plan
```

Example result:

```text
Platform:
  remove L1 billing
  add member acme.billing

Shipping:
  add dependency alias billing -> acme.billing
  rewrite local references

Reporting:
  cannot edit Analytics repository; patch emitted
```

The operation must not claim atomic success if a consumer repository is unavailable.

Temporary explicit redirects may support staged migrations:

```yaml
legacyReferences:
  billing::invoice_portal:
    target: "@billing::invoice_portal"
    expires: 2026-12-01
```

with a warning.

### Change member → dependency

Before conversion, verify that every parent reference into the project addresses something in its published surface.

If so:

```console
wairon relation convert billing --to dependency
```

requires no target-project rewrite.

### Proof

The following operations preserve cross-project reference meaning:

```text
move source path
change git checkout strategy
rename another project's member alias
change nesting depth
add another composition parent
```

Only changes to:

```text
canonical project identity
local dependency alias in the referencing project
target exported entity identity
```

require reference migration.
