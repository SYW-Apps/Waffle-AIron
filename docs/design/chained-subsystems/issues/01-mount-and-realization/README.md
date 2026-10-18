# 01 — Mount and realization: two specs for one subsystem

**Status:** open · Statement: [`problem.md`](../../problem.md), issue 01

## Summary

The parent's mount and the child's own subsystem describe the same thing. A same-id
merge reconciles them at depth one only, discards what the mount declares, and splits
the subsystem at depth two. Creating a chained subsystem leaves the child with no
subsystem of its own.

## Evidence in this repository (`dev`, 2026-09-12)

- Merge rule — the child's copy wins, the mount contributes only its path:
  `mergeMountRealizations`, `src/core/specs.ts` ~351–373, called at ~967.
- Depth-one limit: `rootSubsystems` is filled only at depth 0 (`specs.ts` ~739–741), and
  the root-name shortcut in `qualifyId` (~101–104) is what makes a flat child's ids
  coincide with the mount's.
- Depth-two split, by probe: a child `kid` mounting `extra`, whose own subsystem is also
  `extra`, loads from the top as `kid::extra` (the mount, with its path, no members) and
  `kid::extra::extra` (the content); components are `kid::extra::extra-comp` with
  subsystem `kid::extra::extra`.
- Mount-declared `publicInterfaces`/`trustedLinks` bind nothing when the ids differ:
  boundary rules use each component's own subsystem (`src/core/rules/stereotype-deps.ts`
  ~105, 116–117).
- Creation writes no subsystem into the child: `createChainedSubsystem`,
  `src/core/provision.ts` ~249–279. Probe with the built CLI: after adding a Store with
  `subsystem: kid` in the child, the parent's `status` shows `kid (50%)` and the
  component, while the child's `status` shows 0% and no subsystem, and its `list` shows
  no agent for it.
- The parent's loader never reads the child's L0 (`specs.ts` ~707, 713). Two write paths
  do: saving a subsystem through a namespaced id sets the mount's `parentSystem` from the
  child's L0 name (~1461–1472), and `ensureProjectInitialized` reads it for a fallback
  name.
- The unmerged fix `116d5f7` (issue 02) would not close the depth-two split: members'
  `subsystem:` fields still go through `qualifyId`, leaving a subsystem
  `billing::payments` whose components point at `billing::payments::payments` (Fable 5.1,
  from reading the commit).
- Internalize accepts only a flat child (`provision.ts` ~440–444).

## Analyses

- [Fable 5.1](analyses/fable-5.1.md) — the mount carries only `id` + `projectPath`; no same-id merge — the child's L0 realises the mount and its subsystems load as `<member>::<sub>` at every depth
- [ChatGPT 5.6 Sol (chat)](analyses/chatgpt-5.6-sol_chat.md) — the mount is a project relation, not an L1: it carries no `publicInterfaces`/`trustedLinks`; the child owns zero-to-many real L1s; a mount/child conflict stops migration with `WAI_MIGRATION_CONFLICT` instead of being chosen silently
- [ChatGPT 6 Astra (chat)](analyses/chatgpt-6-astra_chat.md) — membership carries no L1 semantics (at most a `role` note); a project's surface derives from its own L1 publications and descendant exports are not the parent's; creation scaffolds an L0 and a real initial L1; conflicts are reported, never guessed
- [ChatGPT 6 Astra (repository)](analyses/chatgpt-6-astra.md) — a membership record separate from `SubsystemSpec`; the merge is lossy even at every depth; a member's family contract is its L0 export (`publicInterfaces` at `audience: project`), backed by its real L1; create and attach are distinct operations; conflicts reported, never guessed

## Proposals

- none yet

## Decision

- 2026-09-12 — Containment is decided against the project that declares a mount, on every path (decision 3; merged in #69). The mount's shape itself (stage 3) is still open. See [decisions.md](../../decisions.md).
