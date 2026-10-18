_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 03 — Governance: whose rules judge a child's specs

### Diagnosis

A configuration is currently treated partly as project policy and partly as validator invocation policy.

That means the exact same spec can be compliant or noncompliant depending on which ancestor invoked validation. An intermediate project's policy may be skipped altogether.

### Options

**A. Parent always overrides child.**

Simple family semantics, but directly undermines R2 and R7.

**B. Evaluate the project only under its own config. Recommended.**

The parent's family gate aggregates that result.

**C. Parent and child both judge; highest severity wins.**

Could preserve strictness, but detached validation cannot reproduce the parent half without loading ancestors. Violates R2/R10.

**D. Explicit inherited policy floor.**

Potentially useful, but it must be a declared project input rather than an ambient parent effect.

### Recommendation

A project's validation authority is its own configuration.

Platform:

```console
wairon validate --family
```

conceptually performs:

```text
validate Platform under Platform policy
validate Billing under Billing policy
validate Payments under Payments policy
validate Shipping under Shipping policy
check declared composition relations
aggregate
```

If Platform requires an organization baseline, express that requirement explicitly:

```yaml
members:
  billing:
    project: acme.billing
    requirements:
      policyPacks:
        - id: acme/service-baseline
          digest: sha256:...
```

Billing itself must have been validated/approved with that pack.

Platform verifies the attestation; it does not rerun Billing under a surprise configuration.

### Migration

This is intentionally behavior-changing.

A parent that currently catches extra child errors through its stricter configuration would stop doing so.

Provide:

```console
wairon migrate governance --analyze
```

which reports:

```text
Platform currently applies stricter pack X to Billing.
To preserve this policy, require X on the member relation and add X to Billing.
```

Applying the Billing change must happen in Billing's project scope.

### Proof

```text
validate(Billing) == memberResult(Platform.validateFamily, Billing)
```

for all Billing-local findings.

Adding/removing Platform packs must not change Billing's internal result unless the declared member requirements change.
