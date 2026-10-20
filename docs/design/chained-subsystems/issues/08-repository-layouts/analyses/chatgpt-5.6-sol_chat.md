_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 08 — Repository layouts and version control

### Diagnosis

The filesystem containment rule currently doubles as dependency resolution. This makes nested checkouts natural and separate repositories awkward, even though repository location should have no semantic bearing on architecture. Approval and VCS revision are then separately pinned without an explicit relationship.

### Options

**A. Standardize on git submodules.**

Operationally simple for wairon, but explicitly drops a large part of R8.

**B. General source resolvers. Recommended.**

Same project identity, multiple materializations.

**C. Registry/published-artifact only.**

Great for dependencies, insufficient for member deep inspection.

### Recommendation

Support:

```yaml
# monorepo
source:
  path: services/billing
```

```yaml
# side-by-side repo
source:
  path: ../billing
```

```yaml
# git materialization
source:
  git:
    url: ssh://git.example.com/billing.git
    rev: 4c11e0a
```

```yaml
# hosted relation
source:
  hostedProject: acme.billing
```

and:

```console
wairon sync
```

to materialize required member sources into a workspace/cache when necessary.

Do **not** merge VCS and approval pins into one field.

They assert different facts:

```text
git revision = which bytes?
approval digest = which semantic state did a human approve?
```

Bind them next to one another in composition approval.

Hosted backup should therefore back up each project according to that project's own repository configuration. A family export may bundle all projects, but that is export packaging rather than backup ownership.

### Migration

Existing relative paths remain valid source declarations.

Submodules can remain submodules; wairon simply ceases to require them.

Hosted children become actual hosted records as described in issue 09.

### Proof

The same `acme.billing` revision materialized via:

```text
nested checkout
submodule
../billing
wairon cache
hosted fetch
```

must produce the same canonical spec graph and approval identity.
