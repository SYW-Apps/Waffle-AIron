# Stage 4 — composed validation

After stage 3, every project names every other by `alias::name`, and resolution no longer depends on
the bound root. Judgement still does: a chained child that cannot resolve something on its own is
rescued by `resolveThroughParent`, which walks up to the parent and softens or resolves findings
there. The same child therefore gets a different verdict alone than inside its family. Stage 4 gives
every edge exactly one judge.

Decisions this plan rests on: [`decisions.md`](decisions.md) § Stage 2 (9, 19), § Stage 3 design,
and § "Stage 4 preconditions (2026-09-28)" (#5 composition only in family runs, #14 governance as its
own stage, #11 member approval as warnings, no `--legacy`). The model is synthesis §5 ("One judge
per edge; composition is explicit and asked for").

## 1. The owner's gate — `validateProject(P)`

- Pure in P's files: its specs, its configuration, its code, its lock and its pinned externals
  (`.wai/externals.lock.yaml` and the snapshots). It never walks up to a parent, never reads a
  sibling's live tree, and discovers nothing.
- A reference into another project is judged against P's pinned snapshot of that producer: the
  public name exists, its audience covers P, the used member exists with a compatible signature
  (decision 19). What cannot be compared is `EXTERNAL_CHECK_UNAVAILABLE`, never a pass.
- Every finding about a cross-project reference carries a structured resolver result —
  `resolved | missing | ambiguous | unavailable | forbidden` — decided before any severity, plus the
  owner, the call site, the canonical target and the input digest it was judged against.
- Same verdict from every root, with or without the family on disk (`location-independent`,
  `no-discovery-standalone`, `no-softening-by-location`).
- A member with externals prints a one-line hint that `validate --family` composes them.

## 2. The family run — `validateFamily(root)`

`validate` at a parent, or `validate --family` at a member (reach granted first; locally the walk is
explicit, hosted it is the credential's).

- `validateProject(M)` for the root and every member, each prefixed with its project, verbatim — a
  family run never re-judges an owner's edge differently (`one-judge`).
- **Composition** — for each external of each member whose producer is a selected member or
  reachable: compare `lock.used` with the producer's live export table →
  `EXTERNAL_INCOMPATIBLE` (error: a used method or type changed or vanished),
  `EXTERNAL_DRIFTED` (notice: the producer changed, nothing used changed),
  `EXTERNAL_CHECK_UNAVAILABLE` (warning).
- **Family checks** — `MEMBER_NOT_FOUND`, `PROJECT_ID_COLLISION` (stage 3), `MEMBER_UNAPPROVED` and
  `MEMBER_DRIFTED` (warnings, decision #11), `PROJECT_DEPENDENCY_CYCLE` (stage 3), and cross-mount
  code imports judged by the importer.
- An unrelated member's failure changes nothing about another member's verdict
  (`unrelated-failure-changes-nothing`).

## 3. What is deleted

`resolveThroughParent`, its resolution-failure family of codes, `surfaceResolved`, the mount-pool
lookup, the `resolvedThrough` field and every narrative or rule branch that exists only for them. No
`--legacy` evaluator is kept (decision). `sdd_validate_tree` and the hosted data plane call the same
two functions.

## 4. Escalations

As staged in stage 2: `EXTERNAL_NOT_EXPORTED`, `EXPORT_INVALID` and `TRUSTED_LINK_CROSSES_PROJECT`
become errors now that a project's own gate can judge them exactly. `EXTERNAL_UNDECLARED` becomes an
error ("next release" in stage 2). `DEPRECATED_*` forms stay notices until their one-release grace
ends.

## 5. The upgrade report

Instead of `--legacy`, the first validation after upgrading can say what changed: every finding that
is new relative to what the project's last lock recorded, grouped by code, each with its reason
(for example "was resolved through the parent before stage 4"). The design pass decides where this
lives (`validate`, `status` or `doctor --report`) from what the lock actually records.

## 6. Approval context

A project's lock and its gate identity cover its own tree, doctrine, externals lock and pinned
snapshots — never an ancestor's state. Locking a member at its own root and inside the family gives
the same record (`approval-context-both-roots`). Composition subjects and `requireApprovedMembers`
are stage 5.

## 7. Properties

`one-judge`, `location-independent`, `no-discovery-standalone`, `no-softening-by-location`,
`same-config-both-roots`, `renamed-method-seen-from-parent`, `approval-context-both-roots`,
`unrelated-failure-changes-nothing` — over the committed reference family, plus the real-family
proof on a temp copy of Waffler (after its stage-3 migration).

## 8. Not in stage 4

Governance (policy adoption, `requirePolicies`) — its own stage next; composition subjects and
`requireApprovedMembers` (stage 5); `attach`/`rename`/`detach` (stage 6); hosted members as records
(stage 7).
