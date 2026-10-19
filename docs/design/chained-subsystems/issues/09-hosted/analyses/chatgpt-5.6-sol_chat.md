_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._

## 09 — Hosted: a child as a project, a part, or both

### Diagnosis

Hosted wairon currently models only the top root as a project record. A child is instead a namespace inside that record, so permissions, record tools, git and UI cannot naturally apply to the child. Confinement consequently becomes tool-specific forwarding and denial logic.

### Options

**A. Continue virtual child scopes.**

Least migration work, but every new project-level capability repeats the same exception logic.

**B. Every logical project gets a project record. Recommended.**

Relations then compose them.

**C. One family record with nested ACL objects.**

Could work, but reconstructs project records under another name while making reuse/multi-parent composition harder.

### Recommendation

Hosted data model:

```text
Project
  id
  repository
  policy
  approval
  owners

ProjectRelation
  fromProject
  toProject
  kind = member | dependency
  alias
  sourceBinding

Permission
  principal
  project
  capabilities
```

Platform→Shipping membership is then ordinary relation data.

A child-scoped credential gets:

```text
ProjectHandle(acme.shipping)
```

Every storage/query operation is automatically restricted to that handle.

Consequently record-level tools no longer need prohibition:

```console
wairon pack install ...
wairon lock
wairon publish
```

work when authorized on Shipping because Shipping genuinely has a project record.

Parent-family read access may permit traversal through `member` relations, but membership does not automatically grant write permission.

A Shipping credential may consume its pinned Billing surface without Billing access. Updating the dependency from hosted Billing requires permission to read Billing's published surface.

Detaching Shipping from Platform remains a relation mutation owned by Platform or by a principal authorized on that relation.

### Migration

For every current chained child:

1. assign/derive a stable project ID;
2. create a hosted project record;
3. attach its own approval/config/repository metadata;
4. create a `member` relation from the old top project;
5. convert child-scoped credentials to permissions on the new project record.

### Proof

For any API/MCP tool `T`:

```text
T(ProjectHandle(shipping))
```

must be incapable of resolving arbitrary Platform state unless an explicit cross-project read operation and permission exist.

This becomes a storage/security invariant instead of a test matrix of forbidden tool names.
