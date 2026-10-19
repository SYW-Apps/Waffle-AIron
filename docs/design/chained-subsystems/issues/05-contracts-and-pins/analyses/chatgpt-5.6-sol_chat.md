_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 05 — Contracts across the boundary: pins and freshness

### Diagnosis

The current pin is neither quite a dependency lock nor quite a cache. It stores broad family/sibling snapshots, hashes the whole family, is sometimes authoritative even in the presence of live specs, yet freshness is not enforced.

### Options

**A. Keep pins but hash each sibling separately.**

Improves staleness noise but retains mount/family coupling.

**B. Lock exactly the contracts a consumer imports. Recommended.**

Turns pins into a standard dependency concept.

**C. Always consume latest published surfaces.**

Easy operationally but destroys reproducibility and meaningful approval.

**D. Replace surfaces entirely with consumer contract tests.**

Pact-like testing is useful but cannot replace the architecture-level contracts wairon already models.

### Recommendation

Source declaration:

```yaml
dependencies:
  billing:
    project: acme.billing
    imports:
      - invoice_portal
```

Resolved lock:

```yaml
schemaVersion: 2

dependencies:
  billing:
    project: acme.billing
    interfaces:
      invoice_portal:
        digest: sha256:f8a2...
        surfaceFile: surfaces/billing/invoice_portal.yaml
        resolvedRevision: billing-surface-2026-09-12
```

The stored surface includes the actual required interface shape.

Commands:

```console
wairon deps status
wairon deps update billing
wairon deps update billing --from-workspace
```

Status should distinguish:

```text
current
compatible update available
incompatible provider
provider unavailable
unused dependency
missing dependency
```

Not merely `fresh/stale`.

The broad **family surface** becomes unnecessary. A consumer imports contracts from named provider projects.

### Migration

For every old sibling/family pin:

1. inspect actual cross-project references;
2. identify canonical target project/interface;
3. extract one dependency entry per consumed target;
4. discard unused portions.

If `portal` could refer to two sibling surfaces, migration fails rather than preserving today's first-match behavior.

### Proof

```text
editing Payments does not stale Shipping→Billing
adding unrelated Billing interface does not invalidate invoice_portal
removing create_invoice produces a precise compatibility failure
unused locked Billing import is reported
two siblings with same interface id remain distinct by project ID
```
