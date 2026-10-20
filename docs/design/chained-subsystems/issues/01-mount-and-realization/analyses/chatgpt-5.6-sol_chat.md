_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 01 — Mount and realization: two specs for one subsystem

### Diagnosis

The mount is modeled as an L1 subsystem even though it is actually a project relation.

That creates two purported subsystem authorities: the parent's mount and the child's real L1. Flat children then require a merge, non-flat children leave an empty synthetic subsystem, and depth two exposes that the merge is fundamentally positional rather than semantic.

### Options

**A. Parent mount owns L1; child merely realizes it.**

Works for exactly one child subsystem. Breaks as soon as Billing legitimately contains Billing and Payments-style architectural units.

**B. Child owns all architecture; relation carries no L1 data. Recommended.**

Strongest R9/R11 result.

**C. Generate a synthetic L1 wrapper around every child project.**

Would make the tree visually regular, but invents an architectural entity that does not exist. Boundary doctrine would then need special cases around the wrapper.

### Recommendation

A member declaration may contain project-relation metadata only:

```yaml
members:
  shipping:
    project: acme.shipping
    source:
      path: services/shipping
```

Not:

```yaml
# prohibited
members:
  shipping:
    publicInterfaces: [...]
    trustedLinks: [...]
```

Those belong to real Shipping L1 specs.

A child can contain zero, one or many L1s:

```text
Shipping project
 └── dispatch subsystem
     └── dispatch_adapter
```

Platform's UI can visually group:

```text
Platform
 └── project: Shipping
     └── subsystem: dispatch
         └── dispatch_adapter
```

without making `Shipping` itself an L1.

For convenience:

```console
wairon project add-member billing \
  --new services/billing \
  --initial-subsystem billing
```

may create both the project and an initial real L1.

### Migration

For current flat children, discard the synthetic mount half and retain the child's real L1.

If the mount and child disagree on `publicInterfaces` or `trustedLinks`, do **not** choose silently.

Generate:

```text
WAI_MIGRATION_CONFLICT:
mount billing publishes X
child billing publishes Y
```

For non-flat mounts containing architectural fields, migration must ask where those declarations belong or preserve them temporarily as a compatibility overlay.

### Proof

```text
No loader merge operation exists.
Every component belongs to exactly one real L1.
Arbitrary nesting produces the same project/L1 structure at every depth.
Loading Platform and loading Billing agree on Billing's set of L1s.
```
