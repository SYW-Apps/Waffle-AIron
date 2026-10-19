# Stage 7 — hosted members as records

Locally, stages 3–6 made a member a project: its own id, gate, lock, approval and migrations. On a
hosted instance a member is still a path inside its parent's record, reached by a narrowed token
(`platform::billing`) and permissioned only through the parent. Stage 7 makes every member a hosted
project record of its own.

Decisions: [`decisions.md`](decisions.md) § "Stage 7 preconditions (2026-10-01)" (#18 explicit
grants equal to today's reach; member git through the parent's repository) and synthesis D11 ("ancestry
is not authorization").

## 1. Member records

- Every member is a hosted project record with `parentProjectId` and its own id (the member's
  project id). The record names the parent's directory binding plus the member's path, never a copy.
- Upgrade registers every member it finds (members of members included), reported in a plan before
  it writes (stage 6's discipline: plan, confirm, all-or-nothing, audited).
- A member record is a project for every hosted operation: its own permissions, audit (naming the
  member and the initiating composition), approval page, status, lock requests, and data-plane
  binding.

## 2. Permissions — explicit, never inherited

- The resolver gains no project → member rung. Membership never implies permission.
- At upgrade, every principal that reaches a member today through its parent gets an explicit grant
  on the member record — exactly today's reach (`no-widening`), listed and audited.
- A "no" at the member's unit wins; parent and member grants are independent afterwards.

## 3. Tokens

- A token narrowed with a qualifier (`platform::billing`) is rewritten at upgrade to the member's own
  record id (`billing`). The rewrite is a documented widening *within the member only*: the token
  reaches exactly the member's tree, as it did. Old qualified tokens keep resolving for one release.

## 4. Git

- A contained member is committed through its parent's repository under its path: one repository per
  family. A family migration is one commit covering every member it touched
  (`family-commit-covers-members`); a member's history is the path-filtered log.
- Detaching a member is how it gets its own repository.

## 5. UI

- A member record shows a crumb to its parent; a parent shows its members. The family canvas renders
  members as project nodes (stage 3's project nodes, hosted).
- Relation health between projects is `externals status` (stage 2b), per external.

## 6. Properties

`member-is-a-project`, `no-widening` (every principal's reach equal before and after upgrade, over the
RBAC matrix), `audit-names-the-member`, `family-commit-covers-members`, `hosted-and-family-agree`
(hosted verdicts equal the local family run), `member-no-wins` (a member's unit-level "no" beats any
parent grant).

## 7. Not in stage 7

A workspace descriptor for side-by-side members; spec fragments; `validate --at-approval` (stage 8,
optional).
