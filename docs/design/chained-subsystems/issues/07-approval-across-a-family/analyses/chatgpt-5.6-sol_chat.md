_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 07 — Approval across a family

### Diagnosis

Current approval is trying to answer two different questions with one lock structure:

```text
Did this project's owner approve its contents?
Did the larger system approve this composition?
```

A one-level child approval pin cannot represent nested composition such as Payments, while recursively locking children would violate ownership.

### Options

**A. Parent recursively locks every child.**

Strong central semantics but violates R4 and team authority.

**B. Keep approvals fully independent.**

Preserves R2 but leaves “Platform approved” too weak.

**C. Project approval + transitive composition approval. Recommended.**

Separates the claims.

**D. Require parent and child co-signature for every project.**

Provides strong centralized governance but becomes painful or contradictory when a project belongs to multiple systems.

### Recommendation

A project approval should cover at least:

```yaml
projectApproval:
  project: acme.shipping
  specsDigest: sha256:...
  configDigest: sha256:...
  policyPacksDigest: sha256:...
  dependenciesDigest: sha256:...
```

Then Platform:

```yaml
compositionApproval:
  projectApproval: sha256:platform...

  members:
    billing:
      project: acme.billing
      sourceRevision: git:4c11...
      projectApproval: sha256:billing...
      compositionApproval: sha256:billing-composition...

    shipping:
      project: acme.shipping
      sourceRevision: git:8a77...
      projectApproval: sha256:shipping...
```

Billing's composition hash contains Payments:

```yaml
members:
  payments:
    projectApproval: sha256:payments...
```

So Platform transitively binds the whole composition.

Commands could remain simple:

```console
wairon lock
wairon lock --family
```

`lock` approves this project.

`lock --family` additionally approves its current member composition and refuses if a required member lacks a valid approval.

Neither command writes another project.

### Migration

Read existing child approval pins as legacy direct-member attestations.

The first v2:

```console
wairon lock --family
```

creates a new transitive composition section.

Existing project approvals can remain valid as project approvals until project content changes.

### Proof

Changing Payments:

```text
invalidates Payments project approval
invalidates Billing composition approval
invalidates Platform composition approval
does not invalidate Billing's own project approval if Billing itself did not change
```

That distinction is desirable.

Changing Shipping's dependency lock invalidates Shipping project approval because its validated external assumptions changed.
