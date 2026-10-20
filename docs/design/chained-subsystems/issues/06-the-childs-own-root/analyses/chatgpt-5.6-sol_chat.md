_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 06 — Working from the child's own root: status, topology, briefs

### Diagnosis

Derived tooling does not have a consistent ownership model. Validation sometimes crosses the project boundary, topology usually does not, and parent lock actually regenerates child-owned files.

### Options

**A. Parent owns all generated member artifacts.**

Convenient centrally, violates R4.

**B. Child entirely opaque to parent.**

Clean isolation, but unnecessarily sacrifices R3 for declared members.

**C. Federate read models; keep writes local. Recommended.**

Parent may query and aggregate child status/topology/briefs without writing child files.

### Recommendation

Each project produces its own local derived state.

A parent command:

```console
wairon brief @shipping::dispatch_adapter --family
```

does not construct a Shipping brief using Platform assumptions.

It resolves:

```text
@shipping -> acme.shipping
dispatch_adapter -> Shipping-owned component
```

then invokes the Shipping brief builder under a Shipping-bound context and returns the result.

Similarly, parent topology can show:

```text
Platform orchestrator
  -> Shipping project
      -> dispatch_adapter agent
```

but execution entering Shipping changes project authority.

Hosted, that means routing the request to a Shipping-bound project handle/agent credential.

Local CLI can do the same in-process.

Parent lock becomes strictly local:

```console
cd Platform
wairon lock
```

must have zero writes below `services/billing/.wai/` or `services/shipping/.wai/`.

### Migration

Stop cascading derived-file generation immediately in schema v2.

Existing generated child artifacts are left untouched until a child-side regeneration or dedicated cleanup:

```console
cd services/billing
wairon doctor --managed-files
```

No parent-side cleanup.

### Proof

Hash every file under Billing, run:

```console
cd Platform
wairon validate --family
wairon lock
wairon topology
wairon brief @billing::invoice_portal
```

Billing filesystem hash must remain unchanged.

Also:

```text
brief invoked through Platform == brief invoked in Billing
```

modulo presentation metadata about the caller.
