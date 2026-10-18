_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 09 — Hosted: a child as a project, a part, or both

**Diagnosis.** Hosted treats the *record* as the unit and the family as a property of one
record: a member exists only as a mount plus, optionally, a credential narrowed to it
(`server/projects.ts:193-219, 272-307`), permission and audit anchor at the top id
(`request.ts:641-648, 691`), and confinement is a list of refused tools plus per-tool
forwarding (`request.ts:171-205, 375-402, 457-461, 526-557`) because a narrowed
credential is a *top-project* credential with a smaller tree — a shape no tool can reason
about generically. The web UI and git backing gate on records (`web.ts:585-649`,
`admin.ts:363-389`), so a member has neither. The announcement goes to stderr of a
per-request server (`mcp/server.ts:1660-1681`, `request.ts:699`), i.e. nowhere.

**Options.**

| | | |
|---|---|---|
| a | Keep members as scopes; make confinement a binding property and finish the UI | Fixes the list but a member still has no permissions, history or git of its own. |
| b | A member is a hosted project record with `parentProjectId`; the family is a relation between records | Every existing per-project capability (roles, audit, git, approvals, UI, share links) applies to a member unchanged; confinement disappears as a concept. **Recommended**, in two stages. |
| c | Hosted families are relation-only: members are sibling roots, no on-disk nesting | Clean, but breaks containment-based tenant isolation as implemented and every existing hosted family; and local and hosted would differ on what a mount is. |

**Recommendation: b, staged.**

*Stage 1 — no schema change, closes the open holes.*
- Confinement becomes a property of the binding: every tool registration declares
  `scope: 'tree' | 'record'`; under a binding whose `rootPath ≠ topRoot`, a `record` tool
  is refused and an undeclared tool is refused (fail closed). The three sets in
  `request.ts` collapse into one lookup, and a tool added later cannot forget to opt in.
- Announcement in-band: `sdd_get_status` returns `family: { memberOf: 'platform',
  mountedAs: 'billing', governance: 'inherit' }` and the server `instructions` carry one
  line — the agent learns where it is from the first call, not from a log it cannot read.

*Stage 2 — members are projects.*
- `HostedProjectRecord` gains `parentProjectId?` and members keep `rootPath` inside the
  parent's root (containment still holds physically; `resolveSubprojectMounts` is what
  registers them). A registry scan on upgrade registers every mount as a member record
  named by the member's `project.yaml name`; selectors are project ids — `payments`, not
  `platform::billing::payments`.
- Permissions: the hierarchical resolver already walks unit → project; add project →
  member so a parent's role bindings are a *floor* on members (the same word as issue 03,
  deliberately), while a member's own bindings can add. Audit stamps the member's id and
  carries `parentProjectId`. A credential names a project; the parent's credential
  reaches members through that inheritance, a member's credential reaches nothing above
  it (R6, with no list).
- Git: a member has its own binding — its own repository, or the parent's repository with
  a pathspec — so backup covers every `.wai/` in the family (issue 08).
- UI: a member opens as a project with a "member of platform" crumb; the family canvas is
  the landscape restricted to the family (the landscape graph already has project nodes
  and relation edges — `landscape.ts`). Lock, approvals, tokens, share links: the member's
  own.
- Externals: a hosted `ProjectRelationRecord` is an `externals` entry with
  `source: hosted`; relation health and `externals status` compute the same digests
  (issue 05).
- Units versus families: not two answers to one question. A family is *containment*
  (physical, spec-level, one parent); a unit is *organisation* (people, permissions, many
  projects). A member may sit in a different unit than its parent. Keep both; a family is
  a relation of kind `member-of` beside `consumes`, and the landscape draws either.

**Migration.** Stage 1 is behaviour-preserving for every existing tool. Stage 2: the
upgrade registers members and rewrites narrowed entries in `ApiKeyRecord.projects`
(`platform::billing` → `billing`); a narrowed token keeps exactly the tree it had and
gains record-level tools *on the member*, which it could not call before — a documented
widening within the member's own scope, never beyond it.

**Proof.**

- `confinement-is-total` (stage 1): for every registered tool, a binding with
  `rootPath ≠ topRoot` either dispatches into the member tree or refuses; no tool reaches
  the top project's record (the anti-vacuity tests in `.wai/phased_design.md:194` become
  a loop over the tool list).
- `member-is-a-project` (stage 2): every hosted test that runs against a project record
  passes with a member record substituted.
- `no-widening`: a member credential cannot bind, read or list its parent or a sibling;
  a parent credential lists members and binds them.
- `audit-names-the-member`: a tool call under a member binding audits with the member's
  id and `parentProjectId`.
- `announced`: `sdd_get_status` under a member binding returns `family.memberOf`.
